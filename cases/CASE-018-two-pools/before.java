package com.example.settle.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * before.java: 一个类里同时存在两个线程池：结算线程池（规范）与到期的调度线程池（Executors 快捷工厂）。
 */
public class SettlementService {

    private final ThreadPoolExecutor settleExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("settle"),
            new ThreadPoolExecutor.AbortPolicy());

    private final ScheduledExecutorService retryScheduler = Executors.newSingleThreadScheduledExecutor();

    public void settle(String billId) {
        try {
            settleExecutor.execute(() -> doSettle(billId));
        } catch (RejectedExecutionException ex) {
            log.error("settle rejected, bill={}", billId, ex);
        }
    }

    public void scheduleRetry(String billId) {
        retryScheduler.schedule(() -> doSettle(billId), 30, TimeUnit.SECONDS);
    }

    /** 结算线程池的队列积压与活跃线程数（调度线程池没有监控出口）。 */
    public String stats() {
        return settleExecutor.getActiveCount() + "/" + settleExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        settleExecutor.shutdown();
        try {
            if (!settleExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = settleExecutor.shutdownNow();
                log.warn("{} settle tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = settleExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} settle tasks left", pending.size());
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
