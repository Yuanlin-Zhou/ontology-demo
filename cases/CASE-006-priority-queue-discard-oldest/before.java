package com.example.urgent.service;

import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 紧急任务优先队列 + DiscardOldestPolicy（会把优先级最高的任务丢掉）。
 */
public class UrgentTaskDispatcher {

    private final ThreadPoolExecutor dispatcher = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new PriorityBlockingQueue<>(200),
            namedFactory("urgent-task"),
            new ThreadPoolExecutor.DiscardOldestPolicy());

    public void dispatch(String taskId) {
        dispatcher.execute(() -> handle(taskId));
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void handle(String taskId) {
    }
}
