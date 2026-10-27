package com.example.notify.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 通知分发器：自定义拒绝策略，保留被拒绝任务的痕迹并统计。 */
public class NotifyDispatcher {

    private static final Logger log = LoggerFactory.getLogger(NotifyDispatcher.class);

    private final AtomicLong rejectedCount = new AtomicLong();

    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("notify"),
            new RecordingRejectionHandler());

    public NotifyDispatcher() {
        // 应用级线程池必须有确定的关闭逻辑
        Runtime.getRuntime().addShutdownHook(new Thread(this::shutdown, "notify-shutdown"));
    }

    /** 分发通知任务。 */
    public void dispatch(String message) {
        notifier.execute(() -> {
            try {
                // 原始业务行为：处理通知
                handle(message);
            } catch (RuntimeException e) {
                log.error("notify task failed, message={}", message, e);
            }
        });
    }

    /** 拒绝统计。 */
    public long stats() {
        return rejectedCount.get();
    }

    /** 关闭线程池。 */
    public void shutdown() {
        notifier.shutdown();
        try {
            if (!notifier.awaitTermination(30, TimeUnit.SECONDS)) {
                notifier.shutdownNow();
            }
        } catch (InterruptedException e) {
            notifier.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private void handle(String message) {
        // 原始业务处理逻辑占位：实际通知发送
        log.debug("dispatch notify: {}", message);
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    class RecordingRejectionHandler implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
            long total = rejectedCount.incrementAndGet();
            log.warn("notify task rejected, rejectedCount={}, queueSize={}, activeCount={}, poolSize={}",
                    total, executor.getQueue().size(), executor.getActiveCount(), executor.getPoolSize());
        }
    }
}