package com.example.realtime.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** RealtimePushHandler: 复用单个线程池处理实时事件推送。 */
public class RealtimePushHandler {

    private static final Logger log = LoggerFactory.getLogger(RealtimePushHandler.class);

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
            return thread;
        };
    }

    private void push(String eventId) {
    }
}