package com.example.realtime.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 实时事件推送处理器：复用应用级线程池，避免每次调用新建线程池。 */
public class RealtimePushHandler {

    private static final Logger log = LoggerFactory.getLogger(RealtimePushHandler.class);

    /** 应用级共享线程池，保留为可反射观察的实例字段。 */
    private final ThreadPoolExecutor executor;

    public RealtimePushHandler() {
        this.executor = new ThreadPoolExecutor(
                2, 4, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(50),
                namedFactory("realtime-push"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void onEvent(String eventId) {
        try {
            executor.execute(() -> push(eventId));
        } catch (RejectedExecutionException ex) {
            log.warn("push rejected, event={}", eventId, ex);
        }
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        };
    }

    private void push(String eventId) {
        // 原始业务实现占位：实际推送逻辑由具体业务提供。
    }
}