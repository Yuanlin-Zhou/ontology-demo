package com.example.config;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** bad.java: Bean 生命周期缺失 + 任务内异常未处理 + 无监控 + 拒绝异常未捕获。 */
@Configuration
public class NotifyExecutorConfig {

    @Bean(name = "orderNotifier", destroyMethod = "")
    public ThreadPoolExecutor orderNotifier() {
        return new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(200),
                namedFactory("order-notify"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void dispatch(ThreadPoolExecutor notifier, String orderId) {
        notifier.execute(() -> {
            if (orderId == null) {
                throw new IllegalArgumentException("orderId is null");
            }
            send(orderId);
        });
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
