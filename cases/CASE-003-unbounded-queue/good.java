package com.example.report.service;

import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import jakarta.annotation.PreDestroy;

/**
 * good.java: 有界队列 + 命名线程 + 失败降级 + 可监控。
 */
public class ReportExportService {

    private final ThreadPoolExecutor exporter = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("report-export"),
            new ThreadPoolExecutor.AbortPolicy());

    public void export(String reportId) {
        try {
            exporter.execute(() -> doExport(reportId));
        } catch (RejectedExecutionException ex) {
            log.error("export rejected, report={}", reportId, ex);
            pendingReports.offer(reportId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return exporter.getActiveCount() + "/" + exporter.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        exporter.shutdown();
        try {
            if (!exporter.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = exporter.shutdownNow();
                log.warn("{} exports were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = exporter.shutdownNow();
            log.warn("shutdown interrupted, {} exports left unexecuted", pending.size());
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

    private void doExport(String reportId) {
    }
}
