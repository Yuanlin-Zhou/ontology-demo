package com.example.loom.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** before.java: 使用虚拟线程执行阻塞式下游调用。 */
public class LoomNotifier {

    private static final Logger log = LoggerFactory.getLogger(LoomNotifier.class);

    private static final long STOP_TIMEOUT_SECONDS = 30L;

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    private final Semaphore permits;

    private final Consumer<String> downstream;

    private final AtomicLong active = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    private final AtomicBoolean closed = new AtomicBoolean(false);

    private final Object stopLock = new Object();
    private final CountDownLatch stopped = new CountDownLatch(1);

    public LoomNotifier() {
        this(64, LoomNotifier::defaultRemoteNotify);
    }

    public LoomNotifier(int maxConcurrent, Consumer<String> downstream) {
        if (maxConcurrent <= 0) {
            throw new IllegalArgumentException("maxConcurrent must be positive");
        }
        this.permits = new Semaphore(maxConcurrent);
        this.downstream = Objects.requireNonNull(downstream, "downstream");
    }

    public void notify(String orderId) {
        if (closed.get()) {
            rejected.incrementAndGet();
            throw new RejectedExecutionException("LoomNotifier is closed");
        }
        if (!permits.tryAcquire()) {
            rejected.incrementAndGet();
            throw new RejectedExecutionException("Concurrency limit reached: " + orderId);
        }
        active.incrementAndGet();
        boolean submitted = false;
        try {
            virtualExecutor.execute(() -> runTask(orderId));
            submitted = true;
        } catch (RejectedExecutionException e) {
            rejected.incrementAndGet();
            throw e;
        } finally {
            if (!submitted) {
                active.decrementAndGet();
                permits.release();
            }
        }
    }

    private void runTask(String orderId) {
        boolean success = false;
        try {
            downstream.accept(orderId);
            success = true;
        } catch (Throwable t) {
            if (t instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            log.warn("Downstream notify failed for order {}", orderId, t);
        } finally {
            if (success) {
                completed.incrementAndGet();
            } else {
                failed.incrementAndGet();
            }
            active.decrementAndGet();
            permits.release();
            if (closed.get() && active.get() == 0L) {
                stopped.countDown();
            }
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> snapshot = new ConcurrentHashMap<>();
        snapshot.put("active", active.get());
        snapshot.put("completed", completed.get());
        snapshot.put("failed", failed.get());
        snapshot.put("rejected", rejected.get());
        return snapshot;
    }

    public void stop() {
        if (!closed.compareAndSet(false, true)) {
            awaitStopped();
            return;
        }
        if (active.get() == 0L) {
            stopped.countDown();
        }
        virtualExecutor.shutdown();
        awaitStopped();
    }

    private void awaitStopped() {
        boolean interrupted = false;
        try {
            while (true) {
                try {
                    if (stopped.await(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        break;
                    }
                    log.error("LoomNotifier stop timed out with {} active tasks", active.get());
                    break;
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static void defaultRemoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
    }
}