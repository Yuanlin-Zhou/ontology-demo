package com.example.schedule.service;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * bad.java: 任务内直接抛异常且调度线程池没有任何监控与关闭逻辑。
 */
public class RetryScheduler {

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);

    public void scheduleRetry(String orderId) {
        scheduler.scheduleWithFixedDelay(() -> {
            retry(orderId);
            if (System.currentTimeMillis() % 2 == 0) {
                throw new IllegalStateException("retry failed for " + orderId);
            }
        }, 1, 30, TimeUnit.SECONDS);
    }

    private void retry(String orderId) {
    }
}
