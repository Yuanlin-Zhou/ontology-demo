package com.example.log.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 日志异步写入线程池使用 DiscardPolicy（任务被静默丢弃）。 */
public class AsyncLogWriter {

    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1000),
            namedFactory("async-log"),
            new ThreadPoolExecutor.DiscardPolicy());

    public void write(String message) {
        writer.execute(() -> append(message));
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void append(String message) {
    }
}
