package com.example.order.service;

import com.example.order.domain.Order;
import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * good.java: 有界队列 + 命名线程 + 显式拒绝策略 + 超时等待 + ThreadLocal 清理 + 可关闭可监控。
 */
public class OrderSyncService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OrderSyncService.class);


    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ThreadPoolExecutor syncExecutor = new ThreadPoolExecutor(
            8,
            16,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("order-sync"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    public void syncCreated(Order order) {
        syncExecutor.execute(() -> {
            String previous = TENANT.get();
            TENANT.set(order.tenantId());
            try {
                syncRemote(order);
            } catch (RuntimeException ex) {
                log.warn("sync failed, order={}", order.id(), ex);
            } finally {
                restore(previous);
            }
        });
    }

    public Order reload(String id) {
        try {
            return syncExecutor.submit(() -> query(id)).get(3, TimeUnit.SECONDS);
        } catch (TimeoutException ex) {
            throw new IllegalStateException("reload timeout", ex);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("reload interrupted", ex);
        } catch (ExecutionException ex) {
            throw new IllegalStateException("reload failed", ex.getCause());
        }
    }

    /** 暴露队列积压与活跃线程数，便于监控告警。 */
    public String stats() {
        return syncExecutor.getActiveCount() + "/" + syncExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        syncExecutor.shutdown();
        try {
            if (!syncExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = syncExecutor.shutdownNow();
                log.warn("{} tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = syncExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} tasks left unexecuted", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    private static void restore(String previous) {
        if (previous == null) {
            TENANT.remove();
        } else {
            TENANT.set(previous);
        }
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void syncRemote(Order order) {
    }

    private Order query(String id) {
        return null;
    }
}
