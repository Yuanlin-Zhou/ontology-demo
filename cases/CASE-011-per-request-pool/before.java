package com.example.realtime.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 每次调用都新建线程池（并各自关闭），线程与队列无法复用。 */
public class RealtimePushHandler {

    public void onEvent(String eventId) {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                2, 4, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(50),
                namedFactory("realtime-push"),
                new ThreadPoolExecutor.AbortPolicy());
        try {
            executor.execute(() -> push(eventId));
        } catch (RejectedExecutionException ex) {
            log.warn("push rejected, event={}", eventId, ex);
        } finally {
            executor.shutdown();
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
