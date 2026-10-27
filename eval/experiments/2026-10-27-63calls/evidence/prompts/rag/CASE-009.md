## Case
CASE-009

## 原始任务
通知线程池需要自定义拒绝策略：拒绝的任务既要保留痕迹，也要能被监控统计。

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

### java-thread-pool-best-practices.md § CallerRunsPolicy 能形成背压吗？ (source: java-thread-pool-best-practices.md)
`CallerRunsPolicy` 会让调用 `execute()` 的线程执行被拒绝的任务。提交线程因此变慢，后续任务的提交速度也可能下降，所以它具备一定的反馈调节作用。

效果取决于提交者是谁。消息消费线程或批处理调度线程被迫执行任务时，上游拉取速度可能自然下降；Tomcat 请求线程执行长任务时，请求线程会被占住，接口延迟和请求线程池压力也会增加。提交线程持有锁或数据库事务时，任务在调用线程执行还会延长锁和事务的占用时间。

线程池关闭后，`CallerRunsPolicy` 不会再执行任务，而是直接丢弃。业务不能接受丢任务时，需要自定义拒绝处理：记录拒绝次数，返回明确失败，或者把任务写入可靠存储。不要只换一个拒绝策略，就把任务可靠性问题留给调用方。

### java-thread-pool-summary.md § 线程池示例代码 (source: java-thread-pool-summary.md)
可以看到我们上面的代码指定了：

- `corePoolSize`: 核心线程数为 5。
- `maximumPoolSize`：最大线程数 10
- `keepAliveTime` : 等待时间为 1L。
- `unit`: 等待时间的单位为 TimeUnit.SECONDS。
- `workQueue`：任务队列为 `ArrayBlockingQueue`，并且容量为 100;
- `handler`:拒绝策略为 `CallerRunsPolicy`。

**输出结构**：

## 当前代码
```java
package com.example.notify.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** before.java: 自定义拒绝策略，但被拒绝的任务没有任何记录。 */
public class NotifyDispatcher {

    private final ThreadPoolExecutor notifier = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("notify"),
            new SilentRejectionHandler());

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        java.util.concurrent.atomic.AtomicInteger sequence = new java.util.concurrent.atomic.AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    static class SilentRejectionHandler implements RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
            // 直接忽略被拒绝的任务
        }
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
通过无参 stats() 暴露拒绝统计，保留 dispatch(String) 调用入口。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。