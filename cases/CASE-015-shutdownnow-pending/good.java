package com.example.audit.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: shutdownNow() 的返回值被记录并转交补偿通道，审计任务不会丢。 */
public class AuditWriteService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(AuditWriteService.class);
    private final java.util.Queue<Runnable> fallbackQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();


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
                List<Runnable> pending = auditExecutor.shutdownNow();
                log.warn("{} audit tasks were not executed, moving to fallback queue", pending.size());
                pending.forEach(fallbackQueue::offer);
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = auditExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} audit tasks left", pending.size());
            pending.forEach(fallbackQueue::offer);
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
