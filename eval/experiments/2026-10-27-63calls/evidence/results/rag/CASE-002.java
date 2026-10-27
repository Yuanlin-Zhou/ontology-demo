package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * OrderSyncService: 数据同步任务，使用 ThreadLocal 传递租户，并直接 get() 等待结果。
 */
public class OrderSyncService {

    private static final Logger LOGGER = LoggerFactory.getLogger(OrderSyncService.class);

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ExecutorService syncExecutor = Executors.newFixedThreadPool(8, new ThreadFactory() {
        private final AtomicInteger counter = new AtomicInteger();

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "order-sync-" + counter.incrementAndGet());
            t.setUncaughtExceptionHandler((thread, ex) ->
                    LOGGER.error("Uncaught exception in thread {}", thread.getName(), ex));
            return t;
        }
    });

    public void syncCreated(Order order) {
        syncExecutor.submit(() -> {
            String previous = TENANT.get();
            TENANT.set(order.tenantId());
            try {
                syncRemote(order);
            } catch (RuntimeException ex) {
                LOGGER.error("Failed to sync created order, id={}, tenantId={}",
                        order.id(), order.tenantId(), ex);
                throw ex;
            } finally {
                if (previous == null) {
                    TENANT.remove();
                } else {
                    TENANT.set(previous);
                }
            }
        });
    }

    public Order reload(String id) throws Exception {
        Future<Order> future = syncExecutor.submit(() -> query(id));
        try {
            return future.get();
        } catch (Exception ex) {
            LOGGER.error("Failed to reload order, id={}", id, ex);
            throw ex;
        }
    }

    private void syncRemote(Order order) {
        // remote call
    }

    private Order query(String id) {
        return null;
    }
}