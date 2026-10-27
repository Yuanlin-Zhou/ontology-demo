package com.example.loom.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
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

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    private final Semaphore permits;
    private final Consumer<String> downstream;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private final AtomicLong active = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

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
        try {
            virtualExecutor.execute(() -> runTask(orderId));
        } catch (RejectedExecutionException e) {
            active.decrementAndGet();
            permits.release();
            rejected.incrementAndGet();
            throw e;
        } catch (RuntimeException e) {
            active.decrementAndGet();
            permits.release();
            rejected.incrementAndGet();
            throw new RejectedExecutionException("Failed to submit task", e);
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
            log.error("Downstream notify failed for order {}", orderId, t);
        } finally {
            if (success) {
                completed.incrementAndGet();
            } else {
                failed.incrementAndGet();
            }
            active.decrementAndGet();
            permits.release();
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> result = new ConcurrentHashMap<>();
        result.put("active", active.get());
        result.put("completed", completed.get());
        result.put("failed", failed.get());
        result.put("rejected", rejected.get());
        return result;
    }

    public void stop() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        virtualExecutor.shutdown();
        boolean interrupted = false;
        try {
            while (true) {
                try {
                    if (virtualExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                        break;
                    }
                } catch (InterruptedException e) {
                    interrupted = true;
                    log.warn("Interrupted while waiting for LoomNotifier to stop");
                    break;
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