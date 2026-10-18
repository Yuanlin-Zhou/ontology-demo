package com.example.schedule.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * good.java: 显式 ScheduledThreadPoolExecutor + 命名线程 + 显式拒绝策略 + 异常处理 + 监控 + 优雅关闭。
 */
public class RetryScheduler {

    private final ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(
            4,
            namedFactory("order-retry"),
            new ThreadPoolExecutor.AbortPolicy());

    public void scheduleRetry(String orderId) {
        try {
            scheduler.scheduleWithFixedDelay(() -> {
                try {
                    retry(orderId);
                } catch (RuntimeException ex) {
                    log.warn("retry failed, order={}", orderId, ex);
                }
            }, 1, 30, TimeUnit.SECONDS);
        } catch (RejectedExecutionException ex) {
            log.error("retry task rejected, order={}", orderId, ex);
            pendingRetries.offer(orderId);
        }
    }

    /** 延迟队列长度与活跃线程数，便于监控告警。 */
    public String stats() {
        return scheduler.getActiveCount() + "/" + scheduler.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        scheduler.shutdown();
        try {
            if (!scheduler.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = scheduler.shutdownNow();
                log.warn("{} retries were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = scheduler.shutdownNow();
            log.warn("shutdown interrupted, {} retries left unexecuted", pending.size());
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

    private void retry(String orderId) {
    }
}
