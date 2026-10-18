package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * before.java: 订单异步通知，使用 Executors.newFixedThreadPool（无界队列，参数被隐藏）。
 */
public class OrderAsyncService {

    private final ExecutorService notifier = Executors.newFixedThreadPool(16);

    public void notifyCreated(Order order) {
        notifier.execute(() -> sendRemote(order));
    }

    private void sendRemote(Order order) {
        // remote call to the notification platform
    }
}
