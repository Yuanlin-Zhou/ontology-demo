## Case
CASE-017

## 原始任务
用虚拟线程改造阻塞式下游通知，同时不能让下游连接被打满。

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 使用虚拟线程后还需要传统线程池吗？ (source: java-thread-pool-best-practices.md)
虚拟线程适合包含大量阻塞等待的任务。它创建和切换的成本比平台线程低，通常采用每个任务一个虚拟线程的方式，不要把虚拟线程放进固定大小的池里复用。

需要限制数据库或下游接口并发时，继续使用连接池、`Semaphore`、限流器等机制约束具体资源。虚拟线程数量很多，也不会增加数据库连接数、CPU 核数或下游接口容量。

传统平台线程池仍适用于 CPU 密集型任务、需要固定调度线程的任务，以及必须显式控制平台线程和工作队列的组件。项目是否迁移还要看 JDK 版本、框架支持、监控工具和现有异步模型。详细说明可以参考 [虚拟线程常见问题总结](./virtual-thread.md)。

### java-thread-pool-best-practices.md (source: java-thread-pool-best-practices.md)
---
title: Java 线程池最佳实践
description: Java 线程池最佳实践总结：从业务吞吐、任务耗时和下游容量估算线程数与队列长度，讲解队列堆积、拒绝策略、任务超时、异常处理、动态调参、监控和虚拟线程等生产问题。
category: Java
tag:
  - Java并发
head:
  - - meta
    - name: keywords
      content: 线程池最佳实践,ThreadPoolExecutor参数配置,线程池监控,队列堆积,CallerRunsPolicy,动态线程池,任务超时,虚拟线程
---

看到 `corePoolSize = 8`、`maximumPoolSize = 16`、`queueCapacity = 1000` 这组配置，仅凭机器有 8 个 CPU 核心，还判断不了它是否合适。图片压缩、批量查数据库和调用外部接口的耗时构成不同，需要的线程数可能相差很大。任务进入多快、执行多久、允许排队多久，以及数据库和下游能接住多少并发，都会影响最终配置。

七大参数、任务执行流程、阻塞队列及拒绝策略的基础知识，可以先看 [Java 线程池详解](./java-thread-pool-summary.md)。生产环境还要处理参数估算、过载、任务超时和监控，这些问题更依赖业务容量和运行数据。

### java-thread-pool-best-practices.md § 正确声明线程池 (source: java-thread-pool-best-practices.md)
```java
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

public final class NamingThreadFactory implements ThreadFactory {

    private final AtomicInteger sequence = new AtomicInteger();
    private final String prefix;

    public NamingThreadFactory(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public Thread newThread(Runnable task) {
        Thread thread = new Thread(task);
        thread.setName(prefix + "-" + sequence.incrementAndGet());
        thread.setDaemon(false);
        return thread;
    }
}
```

线程名会出现在线程转储、日志和监控数据中。`pool-1-thread-3` 很难判断属于哪项业务，`order-query-3` 则能直接缩小排查范围。

### java-thread-pool-summary.md § Executor 框架介绍 (source: java-thread-pool-summary.md)
FutureTask`，然后直接交给 `ExecutorService` 执行。
4. 最后，主线程可以执行 `Future.get()` 方法来等待任务执行完成，也可以执行 `Future.cancel(boolean mayInterruptIfRunning)` 来尝试取消任务。

## 当前代码
```java
package com.example.loom.service;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** before.java: 使用虚拟线程执行阻塞式下游调用。 */
public class LoomNotifier {

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    public void notify(String orderId) {
        virtualExecutor.execute(() -> remoteNotify(orderId));
    }

    private void remoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
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
保留公开无参构造及 notify(String)；增加公开 LoomNotifier(int maxConcurrent, java.util.function.Consumer<String> downstream) 构造器以注入真实下游。实际回调必须在虚拟线程执行，notify 在下游阻塞时也须及时返回。并发上限在每个实例内生效，提交前快速准入；已满或关闭时同步抛 RejectedExecutionException，不能创建无限等待任务或静默丢弃。正常完成、下游异常、工作线程中断以及启动失败均释放已获取许可；回调异常需要记录且不能阻断后续通知。stats() 返回 Map<String,Long>，提供 active（已接受未结束）、completed（成功）、failed（回调失败）、rejected（每个拒绝请求计一次）。stop() 停止接收并等待已接收通知结束，超时/中断须明确报告；保留调用方中断标志，不在调用线程降级执行下游。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。