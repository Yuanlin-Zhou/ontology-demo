package com.example.report.service;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 报表导出线程池，使用无容量上限的 LinkedBlockingQueue。
 */
public class ReportExportService {

    private final ThreadPoolExecutor exporter = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(),
            new ThreadPoolExecutor.AbortPolicy());

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
