## Case
CASE-018

## 原始任务
结算服务需要两个线程池：一个承接结算任务，一个做失败重试调度；两者都要可观测、可关闭。

## 当前代码
```java
package com.example.settle.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * before.java: 一个类里同时存在两个线程池：结算线程池（规范）与到期的调度线程池（Executors 快捷工厂）。
 */
public class SettlementService {

    private final ThreadPoolExecutor settleExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("settle"),
            new ThreadPoolExecutor.AbortPolicy());

    private final ScheduledExecutorService retryScheduler = Executors.newSingleThreadScheduledExecutor();

    public void settle(String billId) {
        try {
            settleExecutor.execute(() -> doSettle(billId));
        } catch (RejectedExecutionException ex) {
            log.error("settle rejected, bill={}", billId, ex);
        }
    }

    public void scheduleRetry(String billId) {
        retryScheduler.schedule(() -> doSettle(billId), 30, TimeUnit.SECONDS);
    }

    /** 结算线程池的队列积压与活跃线程数（调度线程池没有监控出口）。 */
    public String stats() {
        return settleExecutor.getActiveCount() + "/" + settleExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        settleExecutor.shutdown();
        try {
            if (!settleExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = settleExecutor.shutdownNow();
                log.warn("{} settle tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = settleExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} settle tasks left", pending.size());
            Thread.currentThread().interrupt();
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

    private void doSettle(String billId) {
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