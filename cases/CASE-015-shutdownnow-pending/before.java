package com.example.audit.service;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: shutdownNow() 返回的未执行任务被丢弃。 */
public class AuditWriteService {

    private final ThreadPoolExecutor auditExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("audit-write"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return auditExecutor.getActiveCount() + "/" + auditExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        auditExecutor.shutdown();
        try {
            if (!auditExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                auditExecutor.shutdownNow();
                log.warn("audit executor did not terminate in time");
            }
        } catch (InterruptedException ex) {
            auditExecutor.shutdownNow();
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
}
