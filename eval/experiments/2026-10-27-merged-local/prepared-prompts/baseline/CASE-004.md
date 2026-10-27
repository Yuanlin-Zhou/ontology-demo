## Case
CASE-004

## 原始任务
为失败的订单支付结果增加定时重试能力，用调度线程池实现。

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