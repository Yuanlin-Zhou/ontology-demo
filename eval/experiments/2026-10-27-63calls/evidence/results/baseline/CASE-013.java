package com.example.points.service;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 积分类异步任务服务：应用关闭时等待队列中的任务处理完成后再退出。 */
public class PointsAccrueService {

    private static final Logger log = LoggerFactory.getLogger(PointsAccrueService.class);

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
        try {
            if (!accrueExecutor.awaitTermination(60L, TimeUnit.SECONDS)) {
                log.warn("points accrue executor did not terminate within timeout, forcing shutdown");
                accrueExecutor.shutdownNow();
                if (!accrueExecutor.awaitTermination(30L, TimeUnit.SECONDS)) {
                    log.error("points accrue executor did not terminate after forced shutdown");
                }
            }
        } catch (InterruptedException ex) {
            accrueExecutor.shutdownNow();
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

    private void doAccrue(String userId) {
        // 业务实现：积分累计逻辑
    }
}