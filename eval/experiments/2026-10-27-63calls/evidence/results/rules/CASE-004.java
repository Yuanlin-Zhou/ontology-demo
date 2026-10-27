package com.example.schedule.service;

import java.util.Objects;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 订单重试调度器。
 *
 * <p>使用显式构造的 {@link ScheduledThreadPoolExecutor}（DelayedWorkQueue 为无界队列，
 * 这里不声称有界；容量控制依赖业务侧准入与拒绝处理）。</p>
 */
public class RetryScheduler {

    private static final Logger log = LoggerFactory.getLogger(RetryScheduler.class);

    private static final long DEFAULT_INITIAL_DELAY_MILLIS = 1000L;
    private static final long DEFAULT_DELAY_MILLIS = 30_000L;
    private static final int CORE_POOL_SIZE = 4;
    private static final long SHUTDOWN_GRACE_MILLIS = 200L;
    private static final long SHUTDOWN_AWAIT_MILLIS = 5_000L;

    /** 可反射观察的调度器实例字段。 */
    private final ScheduledThreadPoolExecutor scheduler;

    /** 关闭后无法调度的订单，供补偿观察。 */
    private final Queue<String> pendingRetries = new ConcurrentLinkedQueue<>();

    private final Consumer<String> retryHandler;

    private final long initialDelayMillis;
    private final long delayMillis;

    private final AtomicLong rejectedCount = new AtomicLong();
    private final AtomicLong failedCount = new AtomicLong();
    private final AtomicLong completedCount = new AtomicLong();

    private volatile boolean stopped = false;

    /**
     * 无参构造：没有配置真实下游，scheduleRetry 会明确抛 IllegalStateException。
     */
    public RetryScheduler() {
        this.retryHandler = null;
        this.initialDelayMillis = DEFAULT_INITIAL_DELAY_MILLIS;
        this.delayMillis = DEFAULT_DELAY_MILLIS;
        this.scheduler = createScheduler();
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
        this.scheduler = createScheduler();
    }

    private ScheduledThreadPoolExecutor createScheduler() {
        ThreadFactory threadFactory = runnable -> {
            Thread thread = new Thread(runnable, "order-retry-" + System.nanoTime());
            thread.setDaemon(false);
            thread.setUncaughtExceptionHandler((t, e) ->
                    log.error("Uncaught exception in thread {}", t.getName(), e));
            return thread;
        };
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(
                CORE_POOL_SIZE,
                threadFactory,
                new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    /**
     * 为订单注册定时重试。
     */
    public void scheduleRetry(String orderId) {
        if (retryHandler == null) {
            throw new IllegalStateException("RetryScheduler is not configured with a retry handler");
        }
        if (stopped) {
            pendingRetries.add(orderId);
            rejectedCount.incrementAndGet();
            throw new RejectedExecutionException("RetryScheduler is stopped, order saved for compensation: " + orderId);
        }
        try {
            scheduler.scheduleWithFixedDelay(() -> runRetry(orderId),
                    initialDelayMillis, delayMillis, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            pendingRetries.add(orderId);
            rejectedCount.incrementAndGet();
            log.warn("Retry scheduling rejected, order saved for compensation: {}", orderId, e);
            throw e;
        }
    }

    private void runRetry(String orderId) {
        try {
            retryHandler.accept(orderId);
            completedCount.incrementAndGet();
        } catch (RuntimeException e) {
            failedCount.incrementAndGet();
            log.error("Retry failed for order {}", orderId, e);
            // 不重新抛出，保证后续周期继续执行
        }
    }

    /**
     * 监控指标快照。
     */
    public Stats stats() {
        return new Stats(
                scheduler.getQueue().size(),
                scheduler.getActiveCount(),
                scheduler.getCompletedTaskCount(),
                scheduler.getTaskCount(),
                rejectedCount.get(),
                failedCount.get(),
                completedCount.get(),
                pendingRetries.size());
    }

    /**
     * 生命周期入口：取消未开始的延迟注册，等待已运行回调完成，宽限后强制中断。
     */
    public void stop() {
        stopped = true;
        scheduler.shutdown();
        try {
            if (!scheduler.awaitTermination(SHUTDOWN_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                scheduler.shutdownNow();
                if (!scheduler.awaitTermination(SHUTDOWN_AWAIT_MILLIS, TimeUnit.MILLISECONDS)) {
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
    public record Stats(
            int queueSize,
            int activeCount,
            long completedTaskCount,
            long taskCount,
            long rejectedCount,
            long failedCount,
            long succeededCount,
            int pendingRetries) {
    }
}