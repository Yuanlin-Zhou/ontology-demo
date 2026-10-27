package com.example.batch.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 批量任务线程池：高峰可扩容，空闲可回收超出核心数的线程。
 */
public class BatchJobRunner {

    private static final Logger log = LoggerFactory.getLogger(BatchJobRunner.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 100;

    private final AtomicLong rejectedCount = new AtomicLong();

    private final ThreadPoolExecutor batchExecutor = new ThreadPoolExecutor(
            CORE_POOL_SIZE,
            MAX_POOL_SIZE,
            KEEP_ALIVE_SECONDS,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(QUEUE_CAPACITY),
            namedFactory("batch-job"),
            (r, executor) -> {
                rejectedCount.incrementAndGet();
                throw new RejectedExecutionException("batch job rejected");
            });

    public void run(String jobId) {
        try {
            batchExecutor.execute(() -> execute(jobId));
        } catch (RejectedExecutionException ex) {
            log.error("batch job rejected, job={}", jobId, ex);
        }
    }

    /**
     * 可观测指标快照，供监控采集。
     */
    public BatchExecutorMetrics metrics() {
        return new BatchExecutorMetrics(
                batchExecutor.getQueue().size(),
                batchExecutor.getActiveCount(),
                batchExecutor.getCompletedTaskCount(),
                batchExecutor.getTaskCount(),
                rejectedCount.get());
    }

    public void shutdown() {
        batchExecutor.shutdown();
        try {
            if (!batchExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                batchExecutor.shutdownNow();
            }
        } catch (InterruptedException ex) {
            batchExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void execute(String jobId) {
        // 业务执行逻辑由具体任务实现提供
    }

    public record BatchExecutorMetrics(
            int queueSize,
            int activeCount,
            long completedTaskCount,
            long taskCount,
            long rejectedCount) {
    }
}