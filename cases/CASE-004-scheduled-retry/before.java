package com.example.schedule.service;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 订单重试调度器，使用 Executors.newScheduledThreadPool（内部是无界 DelayedWorkQueue）。
 */
public class RetryScheduler {

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);

    public void scheduleRetry(String orderId) {
        scheduler.scheduleWithFixedDelay(() -> retry(orderId), 1, 30, TimeUnit.SECONDS);
    }

    private void retry(String orderId) {
        // 调用下游重试接口
    }
}
