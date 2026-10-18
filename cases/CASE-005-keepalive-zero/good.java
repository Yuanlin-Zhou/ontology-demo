package com.example.batch.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * good.java: 空闲存活时间 60s（超出核心数的线程可回收）+ 监控 + 优雅关闭。
 */
public class BatchJobRunner {

    private final ThreadPoolExecutor batchExecutor = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100),
            namedFactory("batch-job"),
            new ThreadPoolExecutor.AbortPolicy());

    public void run(String jobId) {
        try {
            batchExecutor.execute(() -> execute(jobId));
        } catch (RejectedExecutionException ex) {
            log.error("batch job rejected, job={}", jobId, ex);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return batchExecutor.getActiveCount() + "/" + batchExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        batchExecutor.shutdown();
        try {
            if (!batchExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = batchExecutor.shutdownNow();
                log.warn("{} jobs were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = batchExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} jobs left unexecuted", pending.size());
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

    private void execute(String jobId) {
    }
}
