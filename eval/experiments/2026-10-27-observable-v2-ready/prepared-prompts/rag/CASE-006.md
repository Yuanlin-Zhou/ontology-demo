## Case
CASE-006

## 原始任务
紧急任务需要优先处理，过载时丢弃的应该是最旧的任务而不是最重要的任务。

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

### java-thread-pool-summary.md § Worker 工作线程机制 (source: java-thread-pool-summary.md)
ThreadPoolExecutor.DiscardOldestPolicy`：此策略将丢弃最早的未处理的任务请求。

举个例子：

举个例子：Spring 通过 `ThreadPoolTaskExecutor` 或者我们直接通过 `ThreadPoolExecutor` 的构造函数创建线程池的时候，当我们不指定 `RejectedExecutionHandler` 拒绝策略来配置线程池的时候，默认使用的是 `AbortPolicy`。在这种拒绝策略下，如果队列满了，`ThreadPoolExecutor` 将抛出 `RejectedExecutionException` 异常来拒绝新来的任务，这代表你将丢失对这个任务的处理。在线程池仍处于运行状态时，`CallerRunsPolicy` 会将被拒绝的任务交给调用者线程执行；线程池已经关闭时，该策略会直接丢弃任务。

```java
public static class CallerRunsPolicy implements RejectedExecutionHandler {

        public CallerRunsPolicy() { }

        public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
            if (!e.isShutdown()) {
                // 直接主线程执行，而不是线程池中的线程执行
                r.run();
            }
        }
    }
```

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

## 当前代码
```java
package com.example.urgent.service;

import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 紧急任务优先队列 + DiscardOldestPolicy（会把优先级最高的任务丢掉）。
 */
public class UrgentTaskDispatcher {

    private final ThreadPoolExecutor dispatcher = new ThreadPoolExecutor(
            4,
            8,
            60L,
            TimeUnit.SECONDS,
            new PriorityBlockingQueue<>(200),
            namedFactory("urgent-task"),
            new ThreadPoolExecutor.DiscardOldestPolicy());

    public void dispatch(String taskId) {
        dispatcher.execute(() -> handle(taskId));
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void handle(String taskId) {
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
保留 dispatch(String)，默认优先级为 0；增加 dispatch(String, int priority)，数值越大越优先，同级按提交顺序 FIFO。增加公开 UrgentTaskDispatcher(java.util.function.Consumer<String> handler) 构造器，接入实际任务处理；保留公开无参构造。队列有界，满载时原子地淘汰最低优先级中最旧且优先级不高于新任务的排队任务，再接收新任务；若所有排队任务都更重要则明确抛出 RejectedExecutionException，不允许淘汰它们。淘汰、拒绝和任务异常需要可观测。允许当前正在执行的任务完成，优先级只约束仍在排队的任务。不得通过任务 ID 猜测优先级。验收同时使用原始生产线程池参数：禁止队列满时扩容非核心线程执行低优先级新任务以绕过拒绝；可固定 core=max 或实现等效的严格准入控制。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。