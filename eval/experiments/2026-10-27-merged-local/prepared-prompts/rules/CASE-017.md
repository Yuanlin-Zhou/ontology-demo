## Case
CASE-017

## 原始任务
用虚拟线程改造阻塞式下游通知，同时不能让下游连接被打满。

## Applicable Engineering Rules
[TP-SHUTDOWN-001] 应用级线程池必须有确定的关闭逻辑 (error/critical)
应用级线程池（字段 / @Bean 形式）必须有确定的关闭逻辑：在应用关闭钩子、@PreDestroy 或
close() 中调用 shutdown()；队列中任务不能丢的业务，还要在关闭前把任务落盘或等待处理完成。

[TP-REJECT-003] 必须处理 RejectedExecutionException (error/high)
当线程池使用 AbortPolicy（默认）时，submit/execute 必须放在 try/catch 中捕获
RejectedExecutionException，并做补偿：重试、持久化后补偿、降级或快速失败返回业务错误码。

[TP-MONITOR-001] 线程池必须可观测 (warning/medium)
线程池需要可观测：暴露或上报 getQueue().size()、getActiveCount()、getCompletedTaskCount()、
getTaskCount() 以及拒绝次数，并针对队列堆积与拒绝配置监控告警；线程名要能区分业务。
上述 getter 属于 ThreadPoolExecutor。虚拟线程 ExecutorService 没有这些 API，不能强转或直接调用；
应在业务准入与回调完成/异常/finally 路径独立统计 active、completed、failed、rejected，验收真实下游调用。

[TP-CREATE-001] 显式创建线程池 (error/critical)
创建业务线程池时不要使用 Executors 的快捷方法（newFixedThreadPool / newSingleThreadExecutor /
newCachedThreadPool / newScheduledThreadPool / newSingleThreadScheduledExecutor），应直接使用
new ThreadPoolExecutor(corePoolSize, maximumPoolSize, keepAliveTime, unit, workQueue, threadFactory, handler)，
把线程数、队列容量和拒绝策略显式写出来。
此限制针对上述平台线程快捷工厂；Java 21 的 newVirtualThreadPerTaskExecutor 不在禁止范围。
虚拟线程不能提高下游连接容量：应在创建任务之前做有界准入，许可在回调 finally 和启动失败时释放，
饱和时明确拒绝或有界补偿，不能用无限量等待许可的虚拟线程堆积请求。

[TP-REJECT-001] 必须显式配置拒绝策略 (error/critical)
创建线程池时必须显式写出拒绝策略（第 7 个参数或 setRejectedExecutionHandler），
并按业务语义选择：核心业务用 AbortPolicy 并在调用侧补偿；允许反压的场景用 CallerRunsPolicy；
不要用默认值蒙混过关。

[TP-CREATE-003] 线程池必须配置线程工厂 (warning/high)
创建线程池时要显式传入 ThreadFactory，让线程名带上业务前缀（如 order-query-3）。
可以使用 new ThreadPoolTaskExecutor() 的 setThreadNamePrefix，或自定义 ThreadFactory。

[TP-SUBMIT-001] submit 返回的 Future 必须被处理 (warning/high)
ExecutorService.submit 返回普通 Future，使用 get(timeout, unit) 消费结果并处理异常；
普通 Future 没有 join、thenAccept 或 whenComplete 方法。只有 CompletableFuture 支持
whenComplete 等回调，阻塞等待也必须有超时保护。execute 的任务可自行捕获并记录异常，
或由 ThreadFactory 为创建的 Thread 设置 Thread#setUncaughtExceptionHandler。
ThreadPoolExecutor 没有 setUncaughtExceptionHandler 方法；线程的处理器也不能观察 submit 封装在 Future 中的异常。

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