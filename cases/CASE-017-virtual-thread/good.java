package com.example.loom.service;

import java.util.concurrent.Semaphore;

/**
 * good.java: 用虚拟线程承载阻塞调用，同时用 Semaphore 限制对下游的连接数，
 * 超时时快速失败 —— 虚拟线程不会增加下游容量，必须显式限流。
 */
public class LoomNotifier {

    private static final Semaphore DOWNSTREAM_LIMIT = new Semaphore(200);

    public void notify(String orderId) {
        Thread.startVirtualThread(() -> {
            if (!DOWNSTREAM_LIMIT.tryAcquire()) {
                log.warn("downstream saturated, drop notify, order={}", orderId);
                return;
            }
            try {
                remoteNotify(orderId);
            } finally {
                DOWNSTREAM_LIMIT.release();
            }
        });
    }

    private void remoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
    }
}
