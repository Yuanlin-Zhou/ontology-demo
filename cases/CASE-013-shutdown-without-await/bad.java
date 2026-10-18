package com.example.points.service;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** bad.java: shutdown() 之后既不等待终止也不监控队列。 */
public class PointsAccrueService {

    private final ThreadPoolExecutor accrueExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("points-accrue"),
            new ThreadPoolExecutor.AbortPolicy());

    public void accrue(String userId) {
        try {
            accrueExecutor.execute(() -> doAccrue(userId));
        } catch (RejectedExecutionException ex) {
            log.error("points accrue rejected, user={}", userId, ex);
        }
    }

    @PreDestroy
    public void stop() {
        accrueExecutor.shutdown();
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void doAccrue(String userId) {
    }
}
