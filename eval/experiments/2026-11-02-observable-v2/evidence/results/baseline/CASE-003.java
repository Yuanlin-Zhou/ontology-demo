package com.example.report.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 报表导出线程池，使用有界队列承接导出请求，过载时拒绝而不是压垮内存。
 */
public class ReportExportService {

    private static final Logger log = LoggerFactory.getLogger(ReportExportService.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 256;
    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 1000L;

    private final ThreadPoolExecutor exporter;

    private final Consumer<String> exportCallback;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    public ReportExportService() {
        this(null);
    }

    public ReportExportService(Consumer<String> exporter) {
        this.exportCallback = exporter;
        this.exporter = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(QUEUE_CAPACITY),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void export(String reportId) {
        if (exportCallback == null) {
            throw new IllegalStateException("export callback not configured");
        }
        try {
            exporter.execute(() -> runExport(reportId));
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            log.error("export rejected, report={}", reportId, ex);
            throw ex;
        }
        submitted.incrementAndGet();
    }

    private void runExport(String reportId) {
        try {
            exportCallback.accept(reportId);
            completed.incrementAndGet();
        } catch (RuntimeException ex) {
            failed.incrementAndGet();
            log.error("export failed, report={}", reportId, ex);
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> result = new ConcurrentHashMap<>();
        result.put("submitted", submitted.get());
        result.put("completed", completed.get());
        result.put("failed", failed.get());
        result.put("rejected", rejected.get());
        return result;
    }

    public void stop() {
        exporter.shutdown();
        boolean interrupted = false;
        try {
            if (!exporter.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                exporter.shutdownNow();
                if (!exporter.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("report export executor did not terminate");
                }
            }
        } catch (InterruptedException ex) {
            interrupted = true;
            exporter.shutdownNow();
            try {
                exporter.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }
}