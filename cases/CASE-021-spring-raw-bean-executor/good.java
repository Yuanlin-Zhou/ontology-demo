package com.example.config;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** good.java: Bean 生命周期完整 —— 任务异常自行处理、拒绝异常补偿、监控埋点、@PreDestroy 关闭。 */
@Configuration
public class NotifyExecutorConfig {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(NotifyExecutorConfig.class);
    private final java.util.Queue<String> pendingNotifications = new java.util.concurrent.ConcurrentLinkedQueue<>();


    private ThreadPoolExecutor notifier;

    @Bean("orderNotifier")
    public ThreadPoolExecutor orderNotifier() {
        this.notifier = new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(200),
                namedFactory("order-notify"),
                new ThreadPoolExecutor.AbortPolicy());
        return this.notifier;
    }

    public void dispatch(String orderId) {
        try {
            notifier.execute(() -> {
                try {
                    if (orderId == null) {
                        throw new IllegalArgumentException("orderId is null");
                    }
                    send(orderId);
                } catch (RuntimeException ex) {
                    log.warn("notify failed, order={}", orderId, ex);
                }
            });
        } catch (RejectedExecutionException ex) {
            log.error("notify rejected, order={}", orderId, ex);
            pendingNotifications.offer(orderId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return notifier.getActiveCount() + "/" + notifier.getQueue().size();
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
}
