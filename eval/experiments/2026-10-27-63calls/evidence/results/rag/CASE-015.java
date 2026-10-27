package com.example.audit.service;

import jakarta.annotation.PreDestroy;
import java.util.Collection;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** before.java: shutdownNow() 返回的未执行任务被丢弃。 */
public class AuditWriteService {

    private static final Logger log = LoggerFactory.getLogger(AuditWriteService.class);

    /** 强制关闭时未执行的任务转交此补偿通道，避免审计任务丢失。 */
    private final Collection<Runnable> fallbackQueue = new ConcurrentLinkedQueue<>();

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
                transferToFallback(auditExecutor.shutdownNow());
                log.warn("audit executor did not terminate in time");
            }
        } catch (InterruptedException ex) {
            transferToFallback(auditExecutor.shutdownNow());
            Thread.currentThread().interrupt();
        }
    }

    private void transferToFallback(Collection<Runnable> pending) {
        if (pending != null && !pending.isEmpty()) {
            fallbackQueue.addAll(pending);
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