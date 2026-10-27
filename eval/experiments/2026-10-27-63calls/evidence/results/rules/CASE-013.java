package com.example.points.service;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 积分类异步任务服务。
 *
 * <p>关闭时按优雅关闭标准模式处理：先 shutdown() 停止接收新任务并继续处理已提交任务，
 * 再 awaitTermination 等待；超时后 shutdownNow() 并再次等待。关闭责任方唯一（本类 @PreDestroy）。</p>
 */
public class PointsAccrueService {

    private static final Logger log = LoggerFactory.getLogger(PointsAccrueService.class);

    /** 优雅关闭等待超时（秒）。 */
    private static final long SHUTDOWN_TIMEOUT_SECONDS = 30L;

    private final ThreadPoolExecutor accrueExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("points-accrue"),
            new ThreadPoolExecutor.AbortPolicy());

    /** 拒绝次数统计（AbortPolicy 抛出异常时由调用侧累加）。 */
    private final AtomicLong rejectedCount = new AtomicLong();

    public void accrue(String userId) {
        try {
            accrueExecutor.execute(() -> doAccrue(userId));
        } catch (RejectedExecutionException ex) {
            rejectedCount.incrementAndGet();
            log.error("points accrue rejected, user={}", userId, ex);
        }
    }

    @PreDestroy
    public void stop() {
        accrueExecutor.shutdown();
        try {
            if (!accrueExecutor.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                log.warn("points accrue executor did not terminate in {}s, forcing shutdownNow",
                        SHUTDOWN_TIMEOUT_SECONDS);
                accrueExecutor.shutdownNow();
                if (!accrueExecutor.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    log.error("points accrue executor still not terminated after shutdownNow");
                }
            }
        } catch (InterruptedException ex) {
            accrueExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 线程池可观测指标快照，供监控上报使用。
     */
    public ExecutorMetrics metrics() {
        return new ExecutorMetrics(
                accrueExecutor.getQueue().size(),
                accrueExecutor.getActiveCount(),
                accrueExecutor.getCompletedTaskCount(),
                accrueExecutor.getTaskCount(),
                rejectedCount.get());
    }

    /** 线程池可观测指标。 */
    public record ExecutorMetrics(
            int queueSize,
            int activeCount,
            long completedTaskCount,
            long taskCount,
            long rejectedCount) {
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
        // 积分入账业务实现（保持原有行为）。
    }
}