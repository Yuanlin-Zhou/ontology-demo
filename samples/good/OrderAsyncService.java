package com.example.order.service;

import com.example.order.domain.Order;
import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * PoC sample: the compliant version of {@code samples/bad/OrderAsyncService.java}.
 */
public class OrderAsyncService {

    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8,
            16,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("order-notify"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    public void notifyCreated(Order order) {
        notifier.execute(() -> {
            String previous = TenantContext.tenantId();
            TenantContext.setTenantId(order.tenantId());
            try {
                sendRemote(order);
            } catch (RuntimeException ex) {
                log.warn("notify failed, order={}", order.id(), ex);
            } finally {
                TenantContext.restore(previous);
            }
        });
    }

    @PreDestroy
    public void stop() {
        notifier.shutdown();
        try {
            if (!notifier.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = notifier.shutdownNow();
                if (!pending.isEmpty()) {
                    log.warn("{} tasks were not executed before shutdown", pending.size());
                }
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = notifier.shutdownNow();
            log.warn("shutdown interrupted, {} tasks left unexecuted", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    /** Exposed so that queue depth / active threads / throughput can be monitored. */
    public String stats() {
        return notifier.getActiveCount() + "/" + notifier.getQueue().size() + "/" + notifier.getCompletedTaskCount();
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void sendRemote(Order order) {
        // remote call to the notification platform
    }
}
