## Case
CASE-013

## 原始任务
积分类异步任务在应用关闭时必须把队列中的任务处理完再退出。

## Retrieved Knowledge (RAG)
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

### java-thread-pool-best-practices.md § 正确关闭线程池 (source: java-thread-pool-best-practices.md)
`shutdown()` 不再接收新任务，会继续处理已经提交的任务；`shutdownNow()` 会尝试中断正在执行的任务，并返回尚未开始执行的任务。两者都不会等待线程池彻底终止。

```java
executor.shutdown();
try {
    if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
        executor.shutdownNow();
        if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
            System.err.println("线程池未能正常退出");
        }
    }
} catch (InterruptedException e) {
    executor.shutdownNow();
    Thread.currentThread().interrupt();
}
```

任务需要正确响应中断，否则 `shutdownNow()` 也不能保证立即停止。应用关闭期间还要决定队列中的任务能否丢失；不能丢的业务任务不应只存在进程内存里。

### java-thread-pool-summary.md § 线程池生命周期状态 (source: java-thread-pool-summary.md)
`ThreadPoolExecutor` 使用 `ctl` 变量（`AtomicInteger` 类型）同时管理线程池的运行状态和工作线程数量。线程池共有 5 种状态：

- **运行中（`RUNNING`）**：接受新任务，并处理队列中的任务。线程池创建后的初始状态。
- **关闭（`SHUTDOWN`）**：不再接受新任务，但会继续处理队列中已有的任务。调用 `shutdown()` 后进入。
- **停止（`STOP`）**：不接受新任务，不处理队列中的任务，并尝试中断正在执行的任务。调用 `shutdownNow()` 后进入。
- **整理中（`TIDYING`）**：所有任务已终止，工作线程数为 0，即将执行 `terminated()` 钩子方法。
- **已终止（`TERMINATED`）**：`terminated()` 方法执行完毕，线程池彻底终结。

状态只能单向流转：运行中（`RUNNING`）→ 关闭（`SHUTDOWN`）→ 整理中（`TIDYING`）→ 已终止（`TERMINATED`），或者运行中（`RUNNING`）→ 停止（`STOP`）→ 整理中（`TIDYING`）→ 已终止（`TERMINATED`）。在关闭（`SHUTDOWN`）状态下再调用 `shutdownNow()` 也会转为停止（`STOP`）。

`shutdown()` 是“温和关闭”——中断空闲线程，但队列中的任务仍会执行完毕。`shutdownNow()` 是“强制关闭”——尝试中断所有正在运行的线程，并将队列中未执行的任务以 `List<Runnable>` 返回。`terminated()` 是一个空的钩子方法，可以通过继承 `ThreadPoolExecutor` 来重写它，用于在线程池终止后做清理工作。

### java-thread-pool-summary.md § ThreadPoolExecutor 类介绍（重要） (source: java-thread-pool-summary.md)
线程池实现类 `ThreadPoolExecutor` 是 `Executor` 框架最核心的类。

## 当前代码
```java
package com.example.points.service;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 只调用 shutdown()，不等待任务执行完成。 */
public class PointsAccrueService {

    private final ThreadPoolExecutor accrueExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("points-accrue"),
            new ThreadPoolExecutor.AbortPolicy());

    public void accrue(String userId) {
        try {
            accrueExecutor.execute(() -> doAccrue(userId));
        } catch (RejectedExecutionException ex) {
            log.error("points accrue rejected, user={}", userId, ex);
        }
    }

    @PreDestroy
    public void stop() {
        accrueExecutor.shutdown();
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void doAccrue(String userId) {
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