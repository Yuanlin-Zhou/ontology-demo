package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;

/**
 * PoC sample: async notification with several thread pool violations.
 * Used by `npm run sample` and by the analyzer smoke test.
 */
public class OrderAsyncService {

    private final ExecutorService notifier = Executors.newFixedThreadPool(16);

    public void notifyCreated(Order order) {
        Future<?> future = notifier.submit(() -> {
            ThreadLocal<String> tenant = new ThreadLocal<>();
            tenant.set(order.tenantId());
            sendRemote(order);
        });
    }

    public void notifyPaid(Order order) {
        notifier.execute(() -> {
            if (ThreadLocalRandom.current().nextBoolean()) {
                throw new IllegalStateException("notify failed");
            }
            sendRemote(order);
        });
    }

    private void sendRemote(Order order) {
        // remote call to the notification platform
    }
}
