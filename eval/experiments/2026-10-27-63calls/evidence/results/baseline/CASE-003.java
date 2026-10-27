package com.example.report.service;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 报表导出线程池，使用有界队列，过载时拒绝请求以避免压垮内存。
 */
public class ReportExportService {

    private static final Logger log = LoggerFactory.getLogger(ReportExportService.class);

    private static final int QUEUE_CAPACITY = 256;

    private final ThreadPoolExecutor exporter = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(QUEUE_CAPACITY),
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