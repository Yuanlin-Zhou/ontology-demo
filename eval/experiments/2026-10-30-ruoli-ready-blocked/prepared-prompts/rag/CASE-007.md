## Case
CASE-007

## 原始任务
日志需要异步写入，过载时不能静默丢日志，必须计数并告警。

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

### java-thread-pool-best-practices.md § 异步任务的异常为什么容易丢？ (source: java-thread-pool-best-practices.md)
通过 `execute()` 提交的 `Runnable` 抛出未捕获异常时，工作线程会异常结束，可以由线程的 `UncaughtExceptionHandler` 记录。通过 `submit()` 提交时，任务通常被包装成 `FutureTask`，异常保存在返回的 `Future` 中；调用方既不保存 `Future`，也不调用 `get()`，异常就可能没有业务日志。

`ThreadPoolExecutor.afterExecute()` 也有同样的区别。使用 `submit()` 时，传给 `afterExecute()` 的 `Throwable` 通常是 `null`，需要判断任务是否为已经完成的 `Future`，再通过 `get()` 取得异常。

异常处理方式最好在项目内统一：调用方消费 `Future`，任务入口主动捕获并记录异常，或者扩展线程池集中处理。日志要带上任务类型、业务 ID 和 Trace ID，不能只打印一段脱离业务的堆栈。

### java-thread-pool-summary.md § `execute()` vs `submit()` (source: java-thread-pool-summary.md)
```java
ExecutorService executorService = Executors.newFixedThreadPool(3);

Future<String> submit = executorService.submit(() -> {
    try {
        Thread.sleep(5000L);
    } catch (InterruptedException e) {
        e.printStackTrace();
    }
    return "abc";
});

String s = submit.get(3, TimeUnit.SECONDS);
System.out.println(s);
executorService.shutdown();
```

输出：

```plain
Exception in thread "main" java.util.concurrent.TimeoutException
  at java.util.concurrent.FutureTask.get(FutureTask.java:205)
```

## 当前代码
```java
package com.example.log.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 日志异步写入线程池使用 DiscardPolicy（任务被静默丢弃）。 */
public class AsyncLogWriter {

    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1000),
            namedFactory("async-log"),
            new ThreadPoolExecutor.DiscardPolicy());

    public void write(String message) {
        writer.execute(() -> append(message));
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void append(String message) {
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
通过无参 stats() 暴露运行及拒绝统计。
增加公开 AsyncLogWriter(java.util.function.Consumer<String> sink) 构造器；write 将原始日志消息交给 sink，不以额外打一条日志替代该 sink。
以上回调是本轮明确的可观察业务边界，不要求实际外网服务。保留原公开无参构造及方法；公开配置构造拒绝 null。无参未配置下游时业务入口同步抛 IllegalStateException，不用空方法或日志伪装业务成功。
业务回调在可观察的实例 ThreadPoolExecutor 工作线程执行；有界队列，原入口异步返回，不在提交线程降级运行回调。回调 RuntimeException 计数且记录日志，不传播到原提交调用者，不阻断后续任务。调用线程原有上下文不变；CASE-002 还须恢复工作线程 TENANT。
提供无参 stats() 返回 Map<String,Long>，包含 submitted（异步入口成功接收）、completed（回调成功）、failed（回调失败）、rejected（饱和或关闭拒绝）；每次入口任务各记一次，reload 不纳入这四项异步入口统计。饱和/关闭时同步抛 RejectedExecutionException 并记录拒绝；CASE-008 同时补偿 SKU。
提供 stop()：停止准入，并等待已接受任务完成；200ms 宽限后可强制关闭，处理未执行任务并再次有界等待，不能终止时明确报错，保留调用者中断标志。关闭后入口明确拒绝。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。