package com.example.order.service;

import com.example.order.domain.Order;
import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * good.java: 显式创建、命名线程、有界队列、显式拒绝策略、可监控、可关闭。
 */
public class OrderAsyncService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OrderAsyncService.class);


    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8,
            16,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("order-notify"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    public void notifyCreated(Order order) {
        notifier.execute(() -> sendRemote(order));
    }

    @PreDestroy
    public void stop() {
        notifier.shutdown();
        try {
            if (!notifier.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = notifier.shutdownNow();
                log.warn("{} tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = notifier.shutdownNow();
            log.warn("shutdown interrupted, {} tasks left unexecuted", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    /** 暴露队列长度与活跃线程数，便于监控与告警。 */
    public String stats() {
        return notifier.getActiveCount() + "/" + notifier.getQueue().size() + "/" + notifier.getCompletedTaskCount();
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

    private void sendRemote(Order order) {
        // remote call
    }
}
