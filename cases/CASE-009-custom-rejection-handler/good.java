package com.example.notify.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.LongAdder;

/** good.java: 自定义拒绝策略记录日志并上报拒绝计数；线程池可监控、可关闭。 */
public class NotifyDispatcher {

    private static final LongAdder REJECTED = new LongAdder();

    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("notify"),
            new AbortWithReport());

    public void dispatch(String orderId) {
        try {
            notifier.execute(() -> send(orderId));
        } catch (RejectedExecutionException ex) {
            pendingNotifications.offer(orderId);
        }
    }

    /** 队列积压、活跃线程数与拒绝次数，用于监控告警。 */
    public String stats() {
        return notifier.getActiveCount() + "/" + notifier.getQueue().size() + "/" + REJECTED.sum();
    }

    @PreDestroy
    public void stop() {
        notifier.shutdown();
        try {
            if (!notifier.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = notifier.shutdownNow();
                log.warn("{} notifications were not sent before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = notifier.shutdownNow();
            log.warn("shutdown interrupted, {} notifications left", pending.size());
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

    private void send(String orderId) {
    }

    static class AbortWithReport implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
            REJECTED.increment();
            log.error("task rejected, poolSize={}, queueSize={}", executor.getPoolSize(), executor.getQueue().size());
            throw new RejectedExecutionException("notify pool saturated");
        }
    }
}
