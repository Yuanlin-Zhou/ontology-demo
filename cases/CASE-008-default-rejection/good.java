package com.example.inventory.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 显式拒绝策略 + 命名线程 + 拒绝补偿 + 监控 + 优雅关闭。 */
public class InventorySyncService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(InventorySyncService.class);
    private final java.util.Queue<String> retryQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();


    private final ThreadPoolExecutor syncExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100),
            namedFactory("inventory-sync"),
            new ThreadPoolExecutor.AbortPolicy());

    public void sync(String sku) {
        try {
            syncExecutor.execute(() -> remoteSync(sku));
        } catch (RejectedExecutionException ex) {
            log.error("inventory sync rejected, sku={}", sku, ex);
            retryQueue.offer(sku);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return syncExecutor.getActiveCount() + "/" + syncExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        syncExecutor.shutdown();
        try {
            if (!syncExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = syncExecutor.shutdownNow();
                log.warn("{} sync tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = syncExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} sync tasks left", pending.size());
            Thread.currentThread().interrupt();
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

    private void remoteSync(String sku) {
    }
}
