package com.example.config;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 通过 @Bean 暴露订单通知线程池，容器关闭时回收，任务异常可见。 */
@Configuration
public class NotifyExecutorConfig {

    private static final Logger log = LoggerFactory.getLogger(NotifyExecutorConfig.class);

    private ThreadPoolExecutor orderNotifier;

    @Bean("orderNotifier")
    public ThreadPoolExecutor orderNotifier() {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(200),
                namedFactory("order-notify"),
                new ThreadPoolExecutor.AbortPolicy());
        this.orderNotifier = executor;
        return executor;
    }

    @PreDestroy
    public void shutdown() {
        ThreadPoolExecutor executor = this.orderNotifier;
        if (executor == null) {
            return;
        }
        executor.shutdown();
        try {
            if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
                executor.shutdownNow();
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.warn("order-notify thread pool did not terminate");
                }
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    public void dispatch(ThreadPoolExecutor notifier, String orderId) {
        notifier.execute(() -> {
            try {
                if (orderId == null) {
                    throw new IllegalArgumentException("orderId is null");
                }
                send(orderId);
            } catch (RuntimeException e) {
                log.error("order notify failed, orderId={}", orderId, e);
                throw e;
            }
        });
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

    private void send(String orderId) {
    }
}