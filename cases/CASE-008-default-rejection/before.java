package com.example.inventory.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** before.java: 5 参数构造，使用默认拒绝策略且没有线程工厂。 */
public class InventorySyncService {

    private final ThreadPoolExecutor syncExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100));

    public void sync(String sku) {
        syncExecutor.execute(() -> remoteSync(sku));
    }

    private void remoteSync(String sku) {
    }
}
