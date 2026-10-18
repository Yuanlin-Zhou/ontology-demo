package com.example.export.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * before.java: 综合场景 —— 导出任务使用 CompletableFuture 编排，配合业务线程池、
 * 线程上下文清理、拒绝补偿、监控与优雅关闭。
 */
public class ExportOrchestrator {

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ThreadPoolExecutor exportExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("export"),
            new ThreadPoolExecutor.AbortPolicy());

    public String export(String reportId) {
        validateTenant(reportId);
        try {
            CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> {
                String previous = TENANT.get();
                TENANT.set(tenantOf(reportId));
                try {
                    return generate(reportId);
                } finally {
                    restore(previous);
                }
            }, exportExecutor);

            try {
                return future.get(30, TimeUnit.SECONDS);
            } catch (TimeoutException ex) {
                future.cancel(true);
                throw new IllegalStateException("export timeout", ex);
            } catch (InterruptedException ex) {
                future.cancel(true);
                Thread.currentThread().interrupt();
                throw new IllegalStateException("export interrupted", ex);
            } catch (Exception ex) {
                throw new IllegalStateException("export failed", ex.getCause());
            }
        } catch (RejectedExecutionException ex) {
            log.error("export rejected, report={}", reportId, ex);
            pendingReports.offer(reportId);
            throw ex;
        }
    }

    /** 队列积压、活跃线程与完成数，用于监控告警。 */
    public String stats() {
        return exportExecutor.getActiveCount() + "/" + exportExecutor.getQueue().size()
                + "/" + exportExecutor.getCompletedTaskCount();
    }

    @PreDestroy
    public void stop() {
        exportExecutor.shutdown();
        try {
            if (!exportExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = exportExecutor.shutdownNow();
                log.warn("{} exports were not generated before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = exportExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} exports left", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    private static void restore(String previous) {
        if (previous == null) {
            TENANT.remove();
        } else {
            TENANT.set(previous);
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

    private void validateTenant(String reportId) {
        if (TENANT.get() == null) {
            TENANT.set(tenantOf(reportId));
        }
    }

    private String tenantOf(String reportId) {
        return "tenant-" + reportId;
    }

    private String generate(String reportId) {
        return "report-" + reportId;
    }
}
