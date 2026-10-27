package com.example.realtime.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 线程池提升为字段复用，配合拒绝补偿、监控与优雅关闭。 */
public class RealtimePushHandler {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(RealtimePushHandler.class);
    private final java.util.Queue<String> pendingEvents = new java.util.concurrent.ConcurrentLinkedQueue<>();


    private final ThreadPoolExecutor pushExecutor = new ThreadPoolExecutor(
            2, 4, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(50),
            namedFactory("realtime-push"),
            new ThreadPoolExecutor.AbortPolicy());

    public void onEvent(String eventId) {
        try {
            pushExecutor.execute(() -> push(eventId));
        } catch (RejectedExecutionException ex) {
            log.warn("push rejected, event={}", eventId, ex);
            pendingEvents.offer(eventId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return pushExecutor.getActiveCount() + "/" + pushExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        pushExecutor.shutdown();
        try {
            if (!pushExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = pushExecutor.shutdownNow();
                log.warn("{} push tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = pushExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} push tasks left", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void push(String eventId) {
    }
}
