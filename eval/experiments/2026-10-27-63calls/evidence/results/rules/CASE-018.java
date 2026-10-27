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
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 结算服务：结算线程池 + 失败重试调度线程池，两者均可观测、可关闭。
 */
public class SettlementService {

    private static final Logger log = LoggerFactory.getLogger(SettlementService.class);

    private final ThreadPoolExecutor settleExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("settle"),
            new ThreadPoolExecutor.AbortPolicy());

    private final ScheduledThreadPoolExecutor retryScheduler = new ScheduledThreadPoolExecutor(
            2,
            namedFactory("settle-retry"),
            new ThreadPoolExecutor.AbortPolicy());

    private final AtomicLong settleRejected = new AtomicLong();
    private final AtomicLong retryRejected = new AtomicLong();

    public SettlementService() {
        retryScheduler.setRemoveOnCancelPolicy(true);
    }

    public void settle(String billId) {
        try {
            settleExecutor.execute(() -> doSettle(billId));
        } catch (RejectedExecutionException ex) {
            settleRejected.incrementAndGet();
            log.error("settle rejected, bill={}", billId, ex);
        }
    }

    public void scheduleRetry(String billId) {
        try {
            retryScheduler.schedule(() -> doSettle(billId), 30, TimeUnit.SECONDS);
        } catch (RejectedExecutionException ex) {
            retryRejected.incrementAndGet();
            log.error("retry schedule rejected, bill={}", billId, ex);
        }
    }

    /** 两个线程池的队列积压、活跃线程数、完成数、任务总数与拒绝次数。 */
    public String stats() {
        return "settle[active=" + settleExecutor.getActiveCount()
                + ",queue=" + settleExecutor.getQueue().size()
                + ",completed=" + settleExecutor.getCompletedTaskCount()
                + ",total=" + settleExecutor.getTaskCount()
                + ",rejected=" + settleRejected.get() + "]"
                + " retry[active=" + retryScheduler.getActiveCount()
                + ",queue=" + retryScheduler.getQueue().size()
                + ",completed=" + retryScheduler.getCompletedTaskCount()
                + ",total=" + retryScheduler.getTaskCount()
                + ",rejected=" + retryRejected.get() + "]";
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
            List<Runnable> pendingSettle = settleExecutor.shutdownNow();
            List<Runnable> pendingRetry = retryScheduler.shutdownNow();
            log.warn("shutdown interrupted, {} settle tasks and {} retry tasks left",
                    pendingSettle.size(), pendingRetry.size());
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