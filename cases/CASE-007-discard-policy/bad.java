package com.example.log.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** bad.java: DiscardPolicy 丢弃日志任务，且没有监控与关闭逻辑。 */
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
