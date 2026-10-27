package com.example.report.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 报表导出线程池，使用有界队列承接导出请求，过载时快速拒绝，避免压垮内存。
 */
public class ReportExportService {

    private static final Logger log = LoggerFactory.getLogger(ReportExportService.class);

    private final ThreadPoolExecutor exporter;

    public ReportExportService() {
        ThreadFactory threadFactory = new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "report-export-" + seq.getAndIncrement());
                t.setDaemon(false);
                return t;
            }
        };

        this.exporter = new ThreadPoolExecutor(
                4,
                8,
                60L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(200),
                threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void export(String reportId) {
        try {
            exporter.execute(() -> doExport(reportId));
        } catch (RejectedExecutionException ex) {
            log.error("export rejected, report={}", reportId, ex);
        }
    }

    private void doExport(String reportId) {
        // 报表导出：耗时较长
    }
}