package com.example.batch.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 批量任务线程池：高峰可扩容，空闲可回收线程。
 */
public class BatchJobRunner {

    private static final Logger log = LoggerFactory.getLogger(BatchJobRunner.class);

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

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        };
    }

    private void execute(String jobId) {
        // 业务执行逻辑
    }
}