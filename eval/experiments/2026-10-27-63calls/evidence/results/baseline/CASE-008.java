package com.example.inventory.service;

import java.util.Collection;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * InventorySyncService: 独立线程池执行库存同步任务。
 * 过载时使用确定的拒绝策略（AbortPolicy），并在调用侧捕获拒绝异常，
 * 将 SKU 放入 retryQueue 供补偿处理。
 */
public class InventorySyncService {

    private static final Logger logger = LoggerFactory.getLogger(InventorySyncService.class);

    /** 被拒绝的 SKU 保留队列，供补偿验收读取。 */
    final Collection<String> retryQueue = new ConcurrentLinkedQueue<>();

    private final ThreadPoolExecutor syncExecutor;

    public InventorySyncService() {
        this.syncExecutor = new ThreadPoolExecutor(
                4, 8, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(100),
                new NamedThreadFactory("inventory-sync-"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void sync(String sku) {
        try {
            syncExecutor.execute(() -> remoteSync(sku));
        } catch (RejectedExecutionException ex) {
            logger.warn("Inventory sync rejected for sku={}, enqueue for compensation", sku);
            retryQueue.add(sku);
        }
    }

    private void remoteSync(String sku) {
        // 原始业务逻辑占位：实际远程同步实现
    }

    private static final class NamedThreadFactory implements ThreadFactory {
        private final String prefix;
        private final AtomicInteger counter = new AtomicInteger(0);

        NamedThreadFactory(String prefix) {
            this.prefix = prefix;
        }

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, prefix + counter.incrementAndGet());
            t.setDaemon(false);
            return t;
        }
    }
}