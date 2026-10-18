package com.example.log.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.LongAdder;

/** good.java: 拒绝的日志任务必须计数并上报，避免静默丢日志。 */
public class AsyncLogWriter {

    private static final LongAdder REJECTED = new LongAdder();

    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1000),
            namedFactory("async-log"),
            new ThreadPoolExecutor.AbortPolicy());

    public void write(String message) {
        try {
            writer.execute(() -> append(message));
        } catch (RejectedExecutionException ex) {
            REJECTED.increment();
            log.warn("log task rejected, queue={}", writer.getQueue().size(), ex);
        }
    }

    /** 队列积压、活跃线程与拒绝次数，用于监控告警。 */
    public String stats() {
        return writer.getActiveCount() + "/" + writer.getQueue().size() + "/" + REJECTED.sum();
    }

    @PreDestroy
    public void stop() {
        writer.shutdown();
        try {
            if (!writer.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = writer.shutdownNow();
                log.warn("{} log tasks were not written before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = writer.shutdownNow();
            log.warn("shutdown interrupted, {} log tasks left", pending.size());
            Thread.currentThread().interrupt();
        }
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
