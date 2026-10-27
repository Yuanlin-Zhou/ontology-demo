## Case
CASE-008

## 原始任务
库存同步任务需要独立线程池，过载时必须有确定的拒绝行为与调用侧补偿。

## Retrieved Knowledge (RAG)
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

### java-thread-pool-summary.md § 线程池参数分析 (source: java-thread-pool-summary.md)
`ThreadPoolExecutor` 类中提供的四个构造方法。我们来看最长的那个，其余三个都是在这个构造方法的基础上产生（其他几个构造方法说白点都是给定某些默认参数的构造方法比如默认制定拒绝策略是什么）。

### java-thread-pool-summary.md § 为什么不推荐使用 `CachedThreadPool`？ (source: java-thread-pool-summary.md)
`CachedThreadPool` 使用的是同步队列 `SynchronousQueue`, 允许创建的线程数量为 `Integer.MAX_VALUE`，可能会创建大量线程，从而导致 OOM。

## 当前代码
```java
package com.example.inventory.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** before.java: 5 参数构造，使用默认拒绝策略且没有线程工厂。 */
public class InventorySyncService {

    private final ThreadPoolExecutor syncExecutor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100));

    public void sync(String sku) {
        syncExecutor.execute(() -> remoteSync(sku));
    }

    private void remoteSync(String sku) {
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
本 PoC 使用名为 retryQueue 的 Collection 字段保留被拒绝的 SKU，供补偿验收读取。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。