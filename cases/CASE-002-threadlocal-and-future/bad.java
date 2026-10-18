package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * bad.java: submit 返回值被忽略、get() 无超时、ThreadLocal 不清理。
 */
public class OrderSyncService {

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ExecutorService syncExecutor = Executors.newFixedThreadPool(8);

    public void syncCreated(Order order) {
        syncExecutor.submit(() -> {
            TENANT.set(order.tenantId());
            syncRemote(order);
        });
    }

    public Order reload(String id) throws Exception {
        Future<Order> future = syncExecutor.submit(() -> query(id));
        return future.get();
    }

    private void syncRemote(Order order) {
    }

    private Order query(String id) {
        return null;
    }
}
