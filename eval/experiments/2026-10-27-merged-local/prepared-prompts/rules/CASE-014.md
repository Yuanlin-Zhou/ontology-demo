## Case
CASE-014

## 原始任务
风控评估线程池在应用关闭时必须能正确响应中断。

## Applicable Engineering Rules
[TP-SHUTDOWN-003] 捕获 InterruptedException 后必须恢复中断状态 (error/medium)
捕获 InterruptedException 后要恢复中断状态（Thread.currentThread().interrupt()）或继续向上抛出，
不要吞掉异常；同时清理逻辑（关线程池、取消 Future）应在恢复中断前完成。

[TP-CONFIG-002] 最大线程数必须有界 (error/critical)
maximumPoolSize 必须是明确的上界。不要使用 Integer.MAX_VALUE；线程数上界要同时考虑 CPU、内存、
栈大小以及数据库连接池 / 下游接口允许的并发。

[TP-CONFIG-004] 任务队列必须有界 (error/critical)
使用有界阻塞队列；普通 FIFO 业务可用 ArrayBlockingQueue(capacity)，并显式写出容量；不要使用
LinkedBlockingQueue()（默认 Integer.MAX_VALUE）、PriorityBlockingQueue、DelayedWorkQueue
等无界队列。队列只用来吸收短时突发流量，不是任务仓库存放地。
业务要求优先级时必须保留优先级排序，不能为满足有界约束改成 FIFO。
实现有界优先级 BlockingQueue<Runnable>：按优先级降序、同级提交序号升序取任务；
offer 的容量检查与插入、过载时选择并替换淘汰对象，都必须在同一队列锁内原子完成。
替换操作若已将新任务入队，拒绝处理器须直接返回；不能再次 execute 同一任务造成重复入队或递归淘汰。
ThreadPoolExecutor 接收 BlockingQueue<Runnable>，不是 BlockingQueue<具体任务子类>。

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

[TP-SHUTDOWN-001] 应用级线程池必须有确定的关闭逻辑 (error/critical)
应用级线程池（字段 / @Bean 形式）必须有确定的关闭逻辑：在应用关闭钩子、@PreDestroy 或
close() 中调用 shutdown()；队列中任务不能丢的业务，还要在关闭前把任务落盘或等待处理完成。

[TP-CONFIG-001] 核心线程数必须显式配置且大于 0 (error/high)
corePoolSize 必须根据高峰任务提交速率与任务耗时估算后显式写出（结合 CPU 核数、I/O 等待比例、
下游容量）。不要留成 0 / 负数 / 未配置状态；确需动态调参时，也要给出经过压测验证的初始值。

## 当前代码
```java
package com.example.risk.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 关闭流程里吞掉了 InterruptedException，没有恢复中断状态。 */
public class RiskEvaluateService {

    private final ThreadPoolExecutor riskExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(300),
            namedFactory("risk-eval"),
            new ThreadPoolExecutor.AbortPolicy());

    public void evaluate(String orderId) {
        try {
            riskExecutor.execute(() -> remoteEvaluate(orderId));
        } catch (RejectedExecutionException ex) {
            log.error("risk evaluate rejected, order={}", orderId, ex);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return riskExecutor.getActiveCount() + "/" + riskExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        riskExecutor.shutdown();
        try {
            if (!riskExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = riskExecutor.shutdownNow();
                log.warn("{} risk tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            log.warn("shutdown interrupted", ex);
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

    private void remoteEvaluate(String orderId) {
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