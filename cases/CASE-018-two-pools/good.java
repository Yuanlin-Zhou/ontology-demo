package com.example.settle.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 两个线程池都显式创建、命名、可监控、可优雅关闭。 */
public class SettlementService {

    private final ThreadPoolExecutor settleExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("settle"),
            new ThreadPoolExecutor.AbortPolicy());

    private final ScheduledThreadPoolExecutor retryScheduler = new ScheduledThreadPoolExecutor(
            2,
            namedFactory("settle-retry"),
            new ThreadPoolExecutor.AbortPolicy());

    public void settle(String billId) {
        try {
            settleExecutor.execute(() -> doSettle(billId));
        } catch (RejectedExecutionException ex) {
            log.error("settle rejected, bill={}", billId, ex);
            retryQueue.offer(billId);
        }
    }

    public void scheduleRetry(String billId) {
        try {
            retryScheduler.schedule(() -> doSettle(billId), 30, TimeUnit.SECONDS);
        } catch (RejectedExecutionException ex) {
            log.error("retry schedule rejected, bill={}", billId, ex);
        }
    }

    /** 两个线程池的队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return settleExecutor.getActiveCount() + "/" + settleExecutor.getQueue().size()
                + "|" + retryScheduler.getActiveCount() + "/" + retryScheduler.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        settleExecutor.shutdown();
        retryScheduler.shutdown();
        try {
            if (!settleExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = settleExecutor.shutdownNow();
                log.warn("{} settle tasks were not executed before shutdown", pending.size());
            }
            if (!retryScheduler.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = retryScheduler.shutdownNow();
                log.warn("{} retry tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = settleExecutor.shutdownNow();
            List<Runnable> pendingRetry = retryScheduler.shutdownNow();
            log.warn("shutdown interrupted, {} + {} tasks left", pending.size(), pendingRetry.size());
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

    private void doSettle(String billId) {
    }
}
