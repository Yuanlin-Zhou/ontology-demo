## Case
CASE-003

## 原始任务
报表导出任务耗时较长，需要独立线程池承接导出请求，过载时不能压垮内存。

## 当前代码
```java
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
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。