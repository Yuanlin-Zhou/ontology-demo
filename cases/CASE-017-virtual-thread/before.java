package com.example.loom.service;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** before.java: 使用虚拟线程执行阻塞式下游调用。 */
public class LoomNotifier {

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    public void notify(String orderId) {
        virtualExecutor.execute(() -> remoteNotify(orderId));
    }

    private void remoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
    }
}
