package com.example.realtime.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * RealtimePushHandler: 复用实例级线程池处理实时事件推送。
 */
public class RealtimePushHandler {

    private static final Logger log = LoggerFactory.getLogger(RealtimePushHandler.class);

    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 1000L;

    private final Consumer<String> receiver;

    private final ThreadPoolExecutor executor;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    private volatile boolean stopped = false;

    public RealtimePushHandler() {
        this.receiver = null;
        this.executor = createExecutor();
    }

    public RealtimePushHandler(Consumer<String> receiver) {
        this.receiver = Objects.requireNonNull(receiver, "receiver");
        this.executor = createExecutor();
    }

    private static ThreadPoolExecutor createExecutor() {
        return new ThreadPoolExecutor(
                2, 4, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(50),
                namedFactory("realtime-push"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        };
    }

    public void onEvent(String eventId) {
        if (stopped) {
            rejected.incrementAndGet();
            log.warn("push rejected (stopped), event={}", eventId);
            throw new RejectedExecutionException("handler stopped");
        }
        if (receiver == null) {
            throw new IllegalStateException("receiver not configured");
        }
        try {
            executor.execute(() -> runTask(eventId));
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            log.warn("push rejected, event={}", eventId, ex);
            throw ex;
        }
        submitted.incrementAndGet();
    }

    private void runTask(String eventId) {
        try {
            receiver.accept(eventId);
            completed.incrementAndGet();
        } catch (RuntimeException ex) {
            failed.incrementAndGet();
            log.error("push failed, event={}", eventId, ex);
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> result = new ConcurrentHashMap<>();
        result.put("submitted", submitted.get());
        result.put("completed", completed.get());
        result.put("failed", failed.get());
        result.put("rejected", rejected.get());
        return result;
    }

    public void stop() {
        stopped = true;
        executor.shutdown();
        boolean terminated = false;
        try {
            terminated = executor.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while stopping realtime push handler", ex);
        }
        if (!terminated) {
            executor.shutdownNow();
            try {
                terminated = executor.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted while force stopping realtime push handler", ex);
            }
        }
        if (!terminated) {
            throw new IllegalStateException("realtime push handler did not terminate");
        }
    }
}