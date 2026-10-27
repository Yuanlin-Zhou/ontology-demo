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

/** before.java: 日志异步写入线程池使用 DiscardPolicy（任务被静默丢弃）。 */
public class AsyncLogWriter {

    private static final Logger log = LoggerFactory.getLogger(AsyncLogWriter.class);

    private final AtomicLong rejectedCount = new AtomicLong();

    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1000),
            namedFactory("async-log"),
            new CountingRejectedHandler());

    public void write(String message) {
        writer.execute(() -> append(message));
    }

    /**
     * 暴露运行及拒绝统计，便于监控与隔离测试。
     */
    public Stats stats() {
        return new Stats(
                writer.getPoolSize(),
                writer.getActiveCount(),
                writer.getQueue().size(),
                writer.getCompletedTaskCount(),
                rejectedCount.get());
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
        // 业务实现：将日志消息写入目标存储。
        log.info("{}", message);
    }

    /** 拒绝时计数并告警，不静默丢弃。 */
    private final class CountingRejectedHandler implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
            long total = rejectedCount.incrementAndGet();
            log.warn("async-log rejected task, totalRejected={}, poolSize={}, activeCount={}, queueSize={}",
                    total, e.getPoolSize(), e.getActiveCount(), e.getQueue().size());
        }
    }

    /** 运行及拒绝统计快照。 */
    public static final class Stats {
        private final int poolSize;
        private final int activeCount;
        private final int queueSize;
        private final long completedTaskCount;
        private final long rejectedCount;

        public Stats(int poolSize, int activeCount, int queueSize,
                     long completedTaskCount, long rejectedCount) {
            this.poolSize = poolSize;
            this.activeCount = activeCount;
            this.queueSize = queueSize;
            this.completedTaskCount = completedTaskCount;
            this.rejectedCount = rejectedCount;
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

        public long getCompletedTaskCount() {
            return completedTaskCount;
        }

        public long getRejectedCount() {
            return rejectedCount;
        }

        @Override
        public String toString() {
            return "Stats{poolSize=" + poolSize
                    + ", activeCount=" + activeCount
                    + ", queueSize=" + queueSize
                    + ", completedTaskCount=" + completedTaskCount
                    + ", rejectedCount=" + rejectedCount + '}';
        }
    }
}