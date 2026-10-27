package com.example.log.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 日志异步写入线程池。
 * 过载时不能静默丢日志：拒绝的任务必须计数并告警。
 */
public class AsyncLogWriter {

    private static final Logger log = LoggerFactory.getLogger(AsyncLogWriter.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 1000;

    private final AtomicLong rejectedCount = new AtomicLong();
    private final AtomicLong submittedCount = new AtomicLong();
    private final AtomicLong completedCount = new AtomicLong();

    private final ThreadPoolExecutor writer;

    public AsyncLogWriter() {
        RejectedExecutionHandler rejectionHandler = (r, executor) -> {
            long total = rejectedCount.incrementAndGet();
            log.warn("Async log write rejected, total rejected={}, queueSize={}, activeCount={}",
                    total, executor.getQueue().size(), executor.getActiveCount());
        };

        this.writer = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                namedFactory("async-log"),
                rejectionHandler);
    }

    public void write(String message) {
        submittedCount.incrementAndGet();
        writer.execute(() -> {
            try {
                append(message);
            } finally {
                completedCount.incrementAndGet();
            }
        });
    }

    /**
     * 暴露运行及拒绝统计，便于监控与测试。
     */
    public Stats stats() {
        return new Stats(
                writer.getQueue().size(),
                writer.getActiveCount(),
                writer.getCompletedTaskCount(),
                writer.getTaskCount(),
                rejectedCount.get(),
                submittedCount.get(),
                completedCount.get());
    }

    /**
     * 应用关闭时调用：停止接收新任务，等待队列中任务处理完成。
     */
    public void shutdown() {
        writer.shutdown();
        try {
            if (!writer.awaitTermination(30, TimeUnit.SECONDS)) {
                log.warn("Async log writer did not terminate in time, forcing shutdownNow");
                writer.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            writer.shutdownNow();
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

    private void append(String message) {
        log.info("{}", message);
    }

    /** 运行及拒绝统计快照。 */
    public static final class Stats {
        private final int queueSize;
        private final int activeCount;
        private final long completedTaskCount;
        private final long taskCount;
        private final long rejectedCount;
        private final long submittedCount;
        private final long completedCount;

        public Stats(int queueSize, int activeCount, long completedTaskCount, long taskCount,
                     long rejectedCount, long submittedCount, long completedCount) {
            this.queueSize = queueSize;
            this.activeCount = activeCount;
            this.completedTaskCount = completedTaskCount;
            this.taskCount = taskCount;
            this.rejectedCount = rejectedCount;
            this.submittedCount = submittedCount;
            this.completedCount = completedCount;
        }

        public int getQueueSize() {
            return queueSize;
        }

        public int getActiveCount() {
            return activeCount;
        }

        public long getCompletedTaskCount() {
            return completedTaskCount;
        }

        public long getTaskCount() {
            return taskCount;
        }

        public long getRejectedCount() {
            return rejectedCount;
        }

        public long getSubmittedCount() {
            return submittedCount;
        }

        public long getCompletedCount() {
            return completedCount;
        }

        @Override
        public String toString() {
            return "Stats{queueSize=" + queueSize
                    + ", activeCount=" + activeCount
                    + ", completedTaskCount=" + completedTaskCount
                    + ", taskCount=" + taskCount
                    + ", rejectedCount=" + rejectedCount
                    + ", submittedCount=" + submittedCount
                    + ", completedCount=" + completedCount
                    + '}';
        }
    }
}