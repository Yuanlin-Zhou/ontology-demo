package com.example.export.service;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** bad.java: 导出任务用公共线程池编排，Future 不等待、ThreadLocal 不清理、线程池不关闭。 */
public class ExportOrchestrator {

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ExecutorService exportExecutor = Executors.newFixedThreadPool(16);

    public void export(String reportId) {
        TENANT.set(reportId);
        exportExecutor.submit(() -> generate(reportId));
        CompletableFuture.runAsync(() -> cleanup(reportId));
    }

    private void cleanup(String reportId) {
        TENANT.set("cleanup-" + reportId);
    }

    private String generate(String reportId) {
        return "report-" + reportId;
    }
}
