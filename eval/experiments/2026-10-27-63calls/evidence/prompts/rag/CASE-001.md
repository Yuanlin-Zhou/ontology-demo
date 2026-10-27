## Case
CASE-001

## 原始任务
给 OrderService 增加订单创建后的异步通知能力，通知失败不能影响下单主流程。

## Retrieved Knowledge (RAG)
### java-thread-pool-summary.md § 为什么不推荐使用 `FixedThreadPool`？ (source: java-thread-pool-summary.md)
`FixedThreadPool` 使用无界队列 `LinkedBlockingQueue`（队列的容量为 Integer.MAX_VALUE）作为线程池的工作队列会对线程池带来如下影响：

1. 当线程池中的线程数达到 `corePoolSize` 后，新任务将在无界队列中等待，因此线程池中的线程数不会超过 `corePoolSize`；
2. 由于使用无界队列时 `maximumPoolSize` 将是一个无效参数，因为不可能存在任务队列满的情况。所以，通过创建 `FixedThreadPool` 的源码可以看出创建的 `FixedThreadPool` 的 `corePoolSize` 和 `maximumPoolSize` 被设置为同一个值。
3. 由于 1 和 2，使用无界队列时 `keepAliveTime` 将是一个无效参数；
4. 运行中的 `FixedThreadPool`（未执行 `shutdown()` 或 `shutdownNow()`）不会拒绝任务，在任务比较多的时候会导致 OOM（内存溢出）。

### java-thread-pool-best-practices.md § 不要让长任务占满共享线程池 (source: java-thread-pool-best-practices.md)
长时间阻塞的任务会占用工作线程，后续短任务只能排队。报表导出、文件处理和慢外部接口适合使用独立的执行资源，或者改成异步任务并向用户返回任务状态。

`CompletableFuture` 只负责任务编排，不会把阻塞式网络请求变成非阻塞操作。没有显式指定 `Executor` 的异步方法通常使用公共线程池，公共线程池被阻塞后，还可能影响应用中的其他异步任务。

### java-thread-pool-summary.md § 为什么不推荐使用 `SingleThreadExecutor`？ (source: java-thread-pool-summary.md)
`SingleThreadExecutor` 和 `FixedThreadPool` 一样，使用的都是容量为 `Integer.MAX_VALUE` 的 `LinkedBlockingQueue`（无界队列）。`SingleThreadExecutor` 使用无界队列作为线程池的工作队列会对线程池带来的影响与 `FixedThreadPool` 相同。说简单点，就是可能会导致 OOM。

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

## 当前代码
```java
package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * before.java: 订单异步通知，使用 Executors.newFixedThreadPool（无界队列，参数被隐藏）。
 */
public class OrderAsyncService {

    private final ExecutorService notifier = Executors.newFixedThreadPool(16);

    public void notifyCreated(Order order) {
        notifier.execute(() -> sendRemote(order));
    }

    private void sendRemote(Order order) {
        // remote call to the notification platform
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
订单输入类型为 com.example.order.domain.Order(String id, String tenantId)。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。