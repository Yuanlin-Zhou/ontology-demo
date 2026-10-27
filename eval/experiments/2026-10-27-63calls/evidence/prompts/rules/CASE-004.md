## Case
CASE-004

## 原始任务
为失败的订单支付结果增加定时重试能力，用调度线程池实现。

## Applicable Engineering Rules
[TP-CREATE-001] 显式创建线程池 (error/critical)
创建业务线程池时不要使用 Executors 的快捷方法（newFixedThreadPool / newSingleThreadExecutor /
newCachedThreadPool / newScheduledThreadPool / newSingleThreadScheduledExecutor），应直接使用
new ThreadPoolExecutor(corePoolSize, maximumPoolSize, keepAliveTime, unit, workQueue, threadFactory, handler)，
把线程数、队列容量和拒绝策略显式写出来。
此限制针对上述平台线程快捷工厂；Java 21 的 newVirtualThreadPerTaskExecutor 不在禁止范围。
虚拟线程不能提高下游连接容量：应在创建任务之前做有界准入，许可在回调 finally 和启动失败时释放，
饱和时明确拒绝或有界补偿，不能用无限量等待许可的虚拟线程堆积请求。

[TP-SHUTDOWN-001] 应用级线程池必须有确定的关闭逻辑 (error/critical)
应用级线程池（字段 / @Bean 形式）必须有确定的关闭逻辑：在应用关闭钩子、@PreDestroy 或
close() 中调用 shutdown()；队列中任务不能丢的业务，还要在关闭前把任务落盘或等待处理完成。

[TP-REJECT-003] 必须处理 RejectedExecutionException (error/high)
当线程池使用 AbortPolicy（默认）时，submit/execute 必须放在 try/catch 中捕获
RejectedExecutionException，并做补偿：重试、持久化后补偿、降级或快速失败返回业务错误码。

[TP-CREATE-003] 线程池必须配置线程工厂 (warning/high)
创建线程池时要显式传入 ThreadFactory，让线程名带上业务前缀（如 order-query-3）。
可以使用 new ThreadPoolTaskExecutor() 的 setThreadNamePrefix，或自定义 ThreadFactory。

[TP-SUBMIT-005] 任务内异常必须被处理 (warning/high)
使用 execute() 提交任务时，任务体内必须 try/catch 并记录日志（同时做补偿），或者通过
ThreadFactory 创建 Thread，并调用 thread.setUncaughtExceptionHandler(handler) 统一上报。
该方法属于 Thread，不属于 ThreadPoolExecutor，禁止调用 executor.setUncaughtExceptionHandler。
不要依赖默认的“打印堆栈到标准错误”；此处理器不能代替 submit 返回的 Future 异常处理。
scheduleWithFixedDelay / scheduleAtFixedRate 的回调抛异常后，该注册的后续周期会被抑制。
必须在实际任务内部 try/catch(RuntimeException) 并记录失败，不重新抛出；提交外层 catch
或 ThreadFactory 的 UncaughtExceptionHandler 不能让周期继续。用失败后至少两轮实际回调验证。
scheduleWithFixedDelay 从上轮结束计算间隔；scheduleAtFixedRate 在慢任务后可能追赶补跑。

[TP-MONITOR-001] 线程池必须可观测 (warning/medium)
线程池需要可观测：暴露或上报 getQueue().size()、getActiveCount()、getCompletedTaskCount()、
getTaskCount() 以及拒绝次数，并针对队列堆积与拒绝配置监控告警；线程名要能区分业务。
上述 getter 属于 ThreadPoolExecutor。虚拟线程 ExecutorService 没有这些 API，不能强转或直接调用；
应在业务准入与回调完成/异常/finally 路径独立统计 active、completed、failed、rejected，验收真实下游调用。

## 当前代码
```java
package com.example.schedule.service;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * before.java: 订单重试调度器，使用 Executors.newScheduledThreadPool（内部是无界 DelayedWorkQueue）。
 */
public class RetryScheduler {

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);

    public void scheduleRetry(String orderId) {
        scheduler.scheduleWithFixedDelay(() -> retry(orderId), 1, 30, TimeUnit.SECONDS);
    }

    private void retry(String orderId) {
        // 调用下游重试接口
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
保留公开无参构造和 scheduleRetry(String)，增加公开 RetryScheduler(long initialDelayMillis, long delayMillis, java.util.function.Consumer<String> retryHandler) 构造器。初始延迟非负，固定延迟严格为正，注入回调非 null；单位均为毫秒。回调在实例 ScheduledThreadPoolExecutor 工作线程执行，每次接收原始 orderId，同一注册使用 scheduleWithFixedDelay：上一轮执行完成后再等待指定延迟，不重叠且不追赶补跑。回调抛 RuntimeException 须记录且后续周期仍执行，不影响其他订单。无参构造没有配置真实下游时 scheduleRetry 明确抛 IllegalStateException，不以空方法或日志冒充业务重试。保留 stats() 监控及 stop() 生命周期入口；关闭取消未开始的延迟注册，不再发起后续周期，等待已运行回调完成，宽限 200ms 后可强制中断，再有界等待终止；无法终止时向调用方报错，捕获中断后保留标志。关闭后 scheduleRetry 同步抛 RejectedExecutionException（不是 IllegalStateException），并将订单保存在 Queue<String> pendingRetries 中供补偿观察；包括与 stop 并发时 execute/schedule 被拒绝的路径。无参未配置状态与公开三参构造的非空校验须分开实现：无参可使用独立初始化或私有构造路径，但不得为兼容无参而允许调用者向公开三参构造传 null。ScheduledThreadPoolExecutor 的 DelayedWorkQueue 仍是无界队列，removeOnCancelPolicy 不是容量上限，不得在注释中声称已经使用了有界队列。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。