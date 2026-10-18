package com.example.urgent.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * good.java: 优先级语义改为"有界队列 + AbortPolicy + 调用侧补偿"，避免静默丢弃任务。
 */
public class UrgentTaskDispatcher {

    private final ThreadPoolExecutor dispatcher = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("urgent-task"),
            new ThreadPoolExecutor.AbortPolicy());

    public void dispatch(String taskId) {
        try {
            dispatcher.execute(() -> handle(taskId));
        } catch (RejectedExecutionException ex) {
            log.error("urgent task rejected, task={}", taskId, ex);
            pendingTasks.offer(taskId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return dispatcher.getActiveCount() + "/" + dispatcher.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        dispatcher.shutdown();
        try {
            if (!dispatcher.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = dispatcher.shutdownNow();
                log.warn("{} tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = dispatcher.shutdownNow();
            log.warn("shutdown interrupted, {} tasks left unexecuted", pending.size());
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

    private void handle(String taskId) {
    }
}
