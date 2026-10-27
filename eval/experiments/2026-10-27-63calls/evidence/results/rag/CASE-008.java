package com.example.inventory.service;

import java.util.Collection;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * InventorySyncService: 库存同步任务使用独立线程池，过载时确定拒绝并记录到 retryQueue 供调用侧补偿。
 */
public class InventorySyncService {

    private static final System.Logger LOGGER = System.getLogger(InventorySyncService.class.getName());

    /** 被拒绝的 SKU 保留队列，供补偿验收读取。 */
    private final Collection<String> retryQueue = new ConcurrentLinkedQueue<>();

    private final ThreadPoolExecutor syncExecutor;

    public InventorySyncService() {
        ThreadFactory threadFactory = new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "inventory-sync-" + seq.getAndIncrement());
                t.setDaemon(false);
                return t;
            }
        };

        this.syncExecutor = new ThreadPoolExecutor(
                4,
                8,
                60L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(100),
                threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void sync(String sku) {
        try {
            syncExecutor.execute(() -> remoteSync(sku));
        } catch (RejectedExecutionException ex) {
            retryQueue.add(sku);
            LOGGER.log(System.Logger.Level.WARNING,
                    "Inventory sync rejected for sku={0}, queued for compensation", sku);
        }
    }

    private void remoteSync(String sku) {
        // 原始业务逻辑占位：实际远程同步实现
    }
}