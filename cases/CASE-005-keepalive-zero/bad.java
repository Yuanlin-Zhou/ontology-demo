package com.example.batch.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * bad.java: 与 before.java 相同，且缺少监控与关闭逻辑。
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
        batchExecutor.execute(() -> execute(jobId));
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
