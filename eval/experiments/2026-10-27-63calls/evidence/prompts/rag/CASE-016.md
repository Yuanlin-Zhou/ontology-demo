## Case
CASE-016

## 原始任务
给订单通知增加一个由 Spring 管理的线程池，参数完整并需要可观测。

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 不要重复创建线程池 (source: java-thread-pool-best-practices.md)
线程池用于复用线程，不应在每个请求或每次方法调用中重新创建。频繁创建会增加线程启动和销毁开销，也容易遗漏关闭逻辑。应用级线程池通常交给容器统一管理生命周期。

Spring 的 `@Async`、定时任务、Web 容器和部分客户端内部也会使用线程池。项目没有显式调用 `new ThreadPoolExecutor()`，不代表不存在需要配置和监控的线程池。

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
package com.example.config;

import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/** before.java: Spring 托管的线程池，配置完整但没有暴露监控指标。 */
@Configuration
public class AsyncExecutorConfig {

    @Bean("orderNotifier")
    public ThreadPoolTaskExecutor orderNotifier() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("order-notify-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        return executor;
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
Spring 线程池 Bean 名保持 orderNotifier；保留公开无参构造和 orderNotifier() 签名；监控入口为 stats() 或静态 stats(bean)。验收只注册当前配置类启动独立 Spring context，没有 Spring Boot 自动配置；使用 MeterRegistry 等依赖时须在本类提供真实 Bean 或自行初始化。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。