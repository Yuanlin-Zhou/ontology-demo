## Case
CASE-003

## 原始任务
报表导出任务耗时较长，需要独立线程池承接导出请求，过载时不能压垮内存。

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 不要让长任务占满共享线程池 (source: java-thread-pool-best-practices.md)
长时间阻塞的任务会占用工作线程，后续短任务只能排队。报表导出、文件处理和慢外部接口适合使用独立的执行资源，或者改成异步任务并向用户返回任务状态。

`CompletableFuture` 只负责任务编排，不会把阻塞式网络请求变成非阻塞操作。没有显式指定 `Executor` 的异步方法通常使用公共线程池，公共线程池被阻塞后，还可能影响应用中的其他异步任务。

### java-thread-pool-best-practices.md § 正确声明线程池 (source: java-thread-pool-best-practices.md)
业务线程池通常需要明确指定线程数、队列容量、线程名称和拒绝策略。使用 `Executors` 的快捷方法虽然方便，但部分方法会创建近似无界的队列或允许线程数持续增长，业务高峰期容易积压大量任务或创建过多线程。

- `newFixedThreadPool()` 和 `newSingleThreadExecutor()` 使用无界的 `LinkedBlockingQueue`，任务持续进入时，队列可能不断增长。
- `newCachedThreadPool()` 使用 `SynchronousQueue`，最大线程数是 `Integer.MAX_VALUE`，提交速度长期高于处理速度时可能创建大量线程。
- `newScheduledThreadPool()` 使用无界的 `DelayedWorkQueue`，同样要考虑延迟任务不断堆积的问题。

因此，普通业务线程池更适合直接使用 `ThreadPoolExecutor`，把容量限制写在配置里：

```java
ThreadFactory threadFactory = new NamingThreadFactory("order-query");

ThreadPoolExecutor executor = new ThreadPoolExecutor(
        8,
        16,
        60L,
        TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(200),
        threadFactory,
        new ThreadPoolExecutor.AbortPolicy()
);
```

示例中的 `8`、`16` 和 `200` 只用于展示参数位置，不能直接用于生产环境。参数要结合业务容量和压测结果确定。

线程工厂至少应该为线程设置有业务含义的名称：

### java-thread-pool-best-practices.md § 面试中怎么回答线程池参数配置？ (source: java-thread-pool-best-practices.md)
回答线程池参数时，可以从任务和系统容量出发：先根据高峰任务提交速率和任务耗时估算并发需求，再区分计算时间和 I/O 等待时间；线程数还要受 CPU、数据库连接池、HTTP 连接池及下游限流约束。队列只吸收短时突发，容量要同时满足业务等待期限和内存限制。初始参数确定后，通过压测和线上监控观察提交速率、完成速率、排队时间、执行时间和拒绝次数，再逐步调整。

面试官继续追问队列堆积时，不要只回答扩大线程池。先比较任务提交速率和完成速率，再看执行时间、线程栈、CPU、连接池与下游延迟。流量上涨可以限流或扩实例；任务变慢要处理 SQL、锁或下游故障；任务已经过期时应快速失败或转入补偿。动态调参只能处理容量配置不合适，不能代替超时、隔离、限流和下游治理。

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
当前用例的测试接口约定：
增加公开 ReportExportService(java.util.function.Consumer<String> exporter) 构造器；export 将原始 reportId 交给 exporter。
以上回调是本轮明确的可观察业务边界，不要求实际外网服务。保留原公开无参构造及方法；公开配置构造拒绝 null。无参未配置下游时业务入口同步抛 IllegalStateException，不用空方法或日志伪装业务成功。
业务回调在可观察的实例 ThreadPoolExecutor 工作线程执行；有界队列，原入口异步返回，不在提交线程降级运行回调。回调 RuntimeException 计数且记录日志，不传播到原提交调用者，不阻断后续任务。调用线程原有上下文不变；CASE-002 还须恢复工作线程 TENANT。
提供无参 stats() 返回 Map<String,Long>，包含 submitted（异步入口成功接收）、completed（回调成功）、failed（回调失败）、rejected（饱和或关闭拒绝）；每次入口任务各记一次，reload 不纳入这四项异步入口统计。饱和/关闭时同步抛 RejectedExecutionException 并记录拒绝；CASE-008 同时补偿 SKU。
提供 stop()：停止准入，并等待已接受任务完成；200ms 宽限后可强制关闭，处理未执行任务并再次有界等待，不能终止时明确报错，保留调用者中断标志。关闭后入口明确拒绝。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。