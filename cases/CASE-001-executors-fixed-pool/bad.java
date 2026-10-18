package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * bad.java: 典型的"看起来没问题"的实现，命中多种线程池违规。
 */
public class OrderAsyncService {

    private final ExecutorService notifier = Executors.newCachedThreadPool();

    public void notifyCreated(Order order) {
        notifier.execute(() -> sendRemote(order));
    }

    private void sendRemote(Order order) {
        // remote call
    }
}
