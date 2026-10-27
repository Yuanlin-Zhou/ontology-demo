package com.example.notify.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 通知线程池：自定义拒绝策略，保留被拒绝任务的痕迹并支持监控统计。 */
public class NotifyDispatcher {

    private static final Logger logger = LoggerFactory.getLogger(NotifyDispatcher.class);

    private final AtomicLong rejectedCount = new AtomicLong();

    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("notify"),
            new RecordingRejectionHandler());

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    /** 提交通知任务。 */
    public void dispatch(String message) {
        notifier.execute(() -> deliver(message));
    }

    /** 实际投递逻辑（保留业务入口，具体实现由下游提供）。 */
    protected void deliver(String message) {
        logger.info("notify: {}", message);
    }

    /** 拒绝统计：返回累计被拒绝的任务数量。 */
    public long stats() {
        return rejectedCount.get();
    }

    /** 自定义拒绝策略：记录被拒绝任务的痕迹并累加统计。 */
    class RecordingRejectionHandler implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
            long total = rejectedCount.incrementAndGet();
            logger.warn("notify task rejected, total rejected={}, poolSize={}, activeCount={}, queueSize={}",
                    total, executor.getPoolSize(), executor.getActiveCount(), executor.getQueue().size());
        }
    }
}