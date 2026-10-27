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
 * 日志异步写入线程池。过载时不再静默丢弃任务：拒绝的任务会被计数，
 * 并通过告警日志输出，同时可通过 {@link #stats()} 观察运行与拒绝统计。
 */
public class AsyncLogWriter {

    private static final Logger logger = LoggerFactory.getLogger(AsyncLogWriter.class);

    private final AtomicLong submittedCount = new AtomicLong();
    private final AtomicLong rejectedCount = new AtomicLong();
    private final AtomicLong completedCount = new AtomicLong();

    private final ThreadPoolExecutor writer;

    public AsyncLogWriter() {
        this.writer = new ThreadPoolExecutor(
                4, 8, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(1000),
                namedFactory("async-log"),
                new CountingRejectHandler());
    }

    public void write(String message) {
        submittedCount.incrementAndGet();
        try {
            writer.execute(() -> {
                try {
                    append(message);
                } finally {
                    completedCount.incrementAndGet();
                }
            });
        } catch (RuntimeException ex) {
            // 兜底：若执行器已关闭等导致 execute 抛出异常，同样计入拒绝并告警
            rejectedCount.incrementAndGet();
            logger.warn("Async log task rejected (executor unavailable), rejectedCount={}", rejectedCount.get(), ex);
        }
    }

    /**
     * 暴露运行及拒绝统计。
     *
     * @return 统计快照
     */
    public Stats stats() {
        return new Stats(
                submittedCount.get(),
                rejectedCount.get(),
                completedCount.get(),
                writer.getPoolSize(),
                writer.getActiveCount(),
                writer.getQueue().size(),
                writer.getTaskCount(),
                writer.getCompletedTaskCount());
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
        // 实际写入逻辑（此处保持原有业务占位行为）
    }

    /** 拒绝策略：计数并告警，避免静默丢弃。 */
    private final class CountingRejectHandler implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            long rejected = rejectedCount.incrementAndGet();
            logger.warn("Async log task rejected due to overload, rejectedCount={}, queueSize={}, activeCount={}",
                    rejected, executor.getQueue().size(), executor.getActiveCount());
        }
    }

    /** 运行及拒绝统计快照。 */
    public static final class Stats {
        private final long submitted;
        private final long rejected;
        private final long completed;
        private final int poolSize;
        private final int activeCount;
        private final int queueSize;
        private final long taskCount;
        private final long completedTaskCount;

        public Stats(long submitted, long rejected, long completed,
                     int poolSize, int activeCount, int queueSize,
                     long taskCount, long completedTaskCount) {
            this.submitted = submitted;
            this.rejected = rejected;
            this.completed = completed;
            this.poolSize = poolSize;
            this.activeCount = activeCount;
            this.queueSize = queueSize;
            this.taskCount = taskCount;
            this.completedTaskCount = completedTaskCount;
        }

        public long getSubmitted() {
            return submitted;
        }

        public long getRejected() {
            return rejected;
        }

        public long getCompleted() {
            return completed;
        }

        public int getPoolSize() {
            return poolSize;
        }

        public int getActiveCount() {
            return activeCount;
        }

        public int getQueueSize() {
            return queueSize;
        }

        public long getTaskCount() {
            return taskCount;
        }

        public long getCompletedTaskCount() {
            return completedTaskCount;
        }

        @Override
        public String toString() {
            return "Stats{submitted=" + submitted
                    + ", rejected=" + rejected
                    + ", completed=" + completed
                    + ", poolSize=" + poolSize
                    + ", activeCount=" + activeCount
                    + ", queueSize=" + queueSize
                    + ", taskCount=" + taskCount
                    + ", completedTaskCount=" + completedTaskCount
                    + '}';
        }
    }
}