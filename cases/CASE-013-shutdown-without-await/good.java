package com.example.points.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: shutdown + awaitTermination + shutdownNow 兜底，并暴露监控指标。 */
public class PointsAccrueService {

    private final ThreadPoolExecutor accrueExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("points-accrue"),
            new ThreadPoolExecutor.AbortPolicy());

    public void accrue(String userId) {
        try {
            accrueExecutor.execute(() -> doAccrue(userId));
        } catch (RejectedExecutionException ex) {
            log.error("points accrue rejected, user={}", userId, ex);
            retryQueue.offer(userId);
        }
    }

    /** 队列积压、活跃线程与完成数，用于监控告警。 */
    public String stats() {
        return accrueExecutor.getActiveCount() + "/" + accrueExecutor.getQueue().size()
                + "/" + accrueExecutor.getCompletedTaskCount();
    }

    @PreDestroy
    public void stop() {
        accrueExecutor.shutdown();
        try {
            if (!accrueExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = accrueExecutor.shutdownNow();
                log.warn("{} accrue tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = accrueExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} accrue tasks left", pending.size());
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

    private void doAccrue(String userId) {
    }
}
