package com.example.batch.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 批量任务线程池，maximumPoolSize 大于 corePoolSize，但空闲存活时间为 0。
 */
public class BatchJobRunner {

    private final ThreadPoolExecutor batchExecutor = new ThreadPoolExecutor(
            4,
            8,
            0L,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(100),
            namedFactory("batch-job"),
            new ThreadPoolExecutor.AbortPolicy());

    public void run(String jobId) {
        try {
            batchExecutor.execute(() -> execute(jobId));
        } catch (java.util.concurrent.RejectedExecutionException ex) {
            log.error("batch job rejected, job={}", jobId, ex);
        }
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void execute(String jobId) {
    }
}
