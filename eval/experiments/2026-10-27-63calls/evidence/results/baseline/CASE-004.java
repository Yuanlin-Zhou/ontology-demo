package com.example.schedule.service;

import java.util.Objects;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 订单重试调度器。
 *
 * 使用 ScheduledThreadPoolExecutor（内部 DelayedWorkQueue 为无界队列）实现固定延迟重试。
 * 注意：DelayedWorkQueue 无界，removeOnCancelPolicy 仅影响取消任务是否从队列移除，
 * 并不构成容量上限。
 */
public class RetryScheduler {

    private static final Logger logger = LoggerFactory.getLogger(RetryScheduler.class);

    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_TERMINATE_WAIT_MILLIS = 5000L;

    private final ScheduledThreadPoolExecutor scheduler;

    private final long initialDelayMillis;
    private final long delayMillis;
    private final Consumer<String> retryHandler;

    private final Queue<String> pendingRetries = new ConcurrentLinkedQueue<>();

    private final AtomicLong scheduledCount = new AtomicLong();
    private final AtomicLong executedCount = new AtomicLong();
    private final AtomicLong failedCount = new AtomicLong();
    private final AtomicLong rejectedCount = new AtomicLong();

    private volatile boolean stopped = false;

    /**
     * 无参构造：未配置真实下游，scheduleRetry 将抛出 IllegalStateException。
     */
    public RetryScheduler() {
        this.scheduler = new ScheduledThreadPoolExecutor(4);
        this.scheduler.setRemoveOnCancelPolicy(true);
        this.initialDelayMillis = 1000L;
        this.delayMillis = 30000L;
        this.retryHandler = null;
    }

    /**
     * 三参构造：注入重试回调。
     *
     * @param initialDelayMillis 初始延迟，非负，单位毫秒
     * @param delayMillis        固定延迟，严格为正，单位毫秒
     * @param retryHandler       重试回调，非 null
     */
    public RetryScheduler(long initialDelayMillis, long delayMillis, Consumer<String> retryHandler) {
        if (initialDelayMillis < 0) {
            throw new IllegalArgumentException("initialDelayMillis must be >= 0");
        }
        if (delayMillis <= 0) {
            throw new IllegalArgumentException("delayMillis must be > 0");
        }
        this.retryHandler = Objects.requireNonNull(retryHandler, "retryHandler must not be null");
        this.initialDelayMillis = initialDelayMillis;
        this.delayMillis = delayMillis;
        this.scheduler = new ScheduledThreadPoolExecutor(4);
        this.scheduler.setRemoveOnCancelPolicy(true);
    }

    public void scheduleRetry(String orderId) {
        if (stopped) {
            rejectedCount.incrementAndGet();
            pendingRetries.add(orderId);
            throw new RejectedExecutionException("RetryScheduler is stopped");
        }
        if (retryHandler == null) {
            throw new IllegalStateException("RetryScheduler is not configured with a retry handler");
        }
        try {
            scheduler.scheduleWithFixedDelay(() -> runRetry(orderId),
                    initialDelayMillis, delayMillis, TimeUnit.MILLISECONDS);
            scheduledCount.incrementAndGet();
        } catch (RejectedExecutionException e) {
            rejectedCount.incrementAndGet();
            pendingRetries.add(orderId);
            throw e;
        }
    }

    private void runRetry(String orderId) {
        try {
            retryHandler.accept(orderId);
            executedCount.incrementAndGet();
        } catch (RuntimeException e) {
            failedCount.incrementAndGet();
            logger.warn("Retry failed for order {}", orderId, e);
        }
    }

    /**
     * 监控统计。
     */
    public Stats stats() {
        return new Stats(
                scheduledCount.get(),
                executedCount.get(),
                failedCount.get(),
                rejectedCount.get(),
                pendingRetries.size(),
                stopped);
    }

    /**
     * 生命周期入口：取消未开始的延迟注册，等待已运行回调完成，宽限 200ms 后强制中断，
     * 再有界等待终止；无法终止时向调用方报错，捕获中断后保留标志。
     */
    public void stop() {
        stopped = true;
        scheduler.shutdown();
        try {
            if (!scheduler.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                scheduler.shutdownNow();
                if (!scheduler.awaitTermination(STOP_TERMINATE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("RetryScheduler did not terminate in time");
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            scheduler.shutdownNow();
            throw new IllegalStateException("Interrupted while stopping RetryScheduler", e);
        }
    }

    /**
     * 监控快照。
     */
    public static final class Stats {
        private final long scheduled;
        private final long executed;
        private final long failed;
        private final long rejected;
        private final int pending;
        private final boolean stopped;

        public Stats(long scheduled, long executed, long failed, long rejected, int pending, boolean stopped) {
            this.scheduled = scheduled;
            this.executed = executed;
            this.failed = failed;
            this.rejected = rejected;
            this.pending = pending;
            this.stopped = stopped;
        }

        public long getScheduled() {
            return scheduled;
        }

        public long getExecuted() {
            return executed;
        }

        public long getFailed() {
            return failed;
        }

        public long getRejected() {
            return rejected;
        }

        public int getPending() {
            return pending;
        }

        public boolean isStopped() {
            return stopped;
        }
    }
}