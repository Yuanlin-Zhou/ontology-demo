## Case
CASE-020

## 原始任务
导出任务需要用 CompletableFuture 编排，并保证线程池、线程上下文与关闭流程都受控。

## 当前代码
```java
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
```

## 交付要求
保持原始业务行为、类名和公开接口；只做任务及适用规范要求的必要修改。先保证代码可编译、功能正确，再核对适用规则。
使用目标运行环境真实存在的 API 和已声明的依赖，不臆造方法、不为满足规范添加无关业务。规范中的代码片段仅作示意，应按实际接收者类型选择正确 API。
返回完整 Java 源码；不要通过删除业务逻辑、空实现或改变接口来消除违规。

## 实验交付约定（三种策略相同）
返回完整的单个 Java 源文件，保留当前类名和公开方法签名，完成原始任务；不添加当前任务之外的业务功能。
补齐片段中省略的必要成员与业务实现，不用空方法替代任务。使用 Java 21，返回源码，不输出解释文本。
如服务持有 ExecutorService，保留可反射观察的实例字段，便于隔离测试；不要为没有并发需求的任务额外创建线程池。
可用 classpath：JDK 21、Spring 6.2.11、Micrometer Core/Observation/Commons 1.14.11、Jakarta Annotation 2.1.1、SLF4J API/Simple 2.0.17。仅在任务需要时使用；不得假定其他依赖存在。
日志使用 JDK 日志或已配置的 SLF4J，并定义实际 logger 成员。
当前用例的测试接口约定：
保留 TENANT、公开无参构造、export(String) 返回 report- 加 reportId、stats() 和 stop()；增加公开 ExportOrchestrator(long timeoutMillis, java.util.function.Function<String,String> generator) 构造器，注入实际导出和等待超时。默认超时 30 秒。真实回调必须在可观察的实例业务 ThreadPoolExecutor 上执行，回调内 TENANT=tenant- 加 reportId；正常、异常、超时、调用者中断、拒绝及关闭都恢复调用者和工作线程原上下文。超时或中断需取消实际执行任务并中断可中断的回调，不能仅取消 CompletableFuture 完成状态；保留原始异常原因及调用者中断标志。排队超时应移除已取消任务，过载或关闭时同步拒绝并将 reportId 保存到 Queue<String> pendingReports。stop() 停止准入；PoC 宽限等待为 200ms，随后强制关闭，取消未启动和在执行的任务，使等待结果的调用者及时结束；不响应中断时明确报告失败。每次 stop 都等待关闭完成，包括重复/并发调用。用 CompletableFuture 编排结果，但保留独立 FutureTask 或等价可取消执行句柄；CompletableFuture.cancel(true) 不会中断执行线程。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。