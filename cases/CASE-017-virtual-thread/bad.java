package com.example.loom.service;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** bad.java: 虚拟线程执行器既没有监控也没有关闭逻辑，下游容量也未受限。 */
public class LoomNotifier {

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    public void notify(String orderId) {
        virtualExecutor.execute(() -> remoteNotify(orderId));
    }

    private void remoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
    }
}
