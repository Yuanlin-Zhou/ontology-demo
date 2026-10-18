package com.example.report.service;

import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * bad.java: 队列容量写成 500000（等于无界），且未处理提交失败。
 */
public class ReportExportService {

    private final ThreadPoolExecutor exporter = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(500000),
            new ThreadPoolExecutor.AbortPolicy());

    public void export(String reportId) {
        exporter.submit(() -> doExport(reportId));
    }

    private void doExport(String reportId) {
    }
}
