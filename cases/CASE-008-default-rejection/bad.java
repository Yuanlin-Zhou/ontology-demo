package com.example.inventory.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** bad.java: 默认 AbortPolicy 但调用侧没有捕获拒绝异常。 */
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
