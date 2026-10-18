package com.example.risk.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 关闭流程完整，且 catch (InterruptedException) 中恢复了中断状态。 */
public class RiskEvaluateService {

    private final ThreadPoolExecutor riskExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(300),
            namedFactory("risk-eval"),
            new ThreadPoolExecutor.AbortPolicy());

    public void evaluate(String orderId) {
        try {
            riskExecutor.execute(() -> remoteEvaluate(orderId));
        } catch (RejectedExecutionException ex) {
            log.error("risk evaluate rejected, order={}", orderId, ex);
            retryQueue.offer(orderId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return riskExecutor.getActiveCount() + "/" + riskExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        riskExecutor.shutdown();
        try {
            if (!riskExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = riskExecutor.shutdownNow();
                log.warn("{} risk tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = riskExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} risk tasks left", pending.size());
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

    private void remoteEvaluate(String orderId) {
    }
}
