## Case
CASE-006

## 原始任务
紧急任务需要优先处理，过载时丢弃的应该是最旧的任务而不是最重要的任务。

## Applicable Engineering Rules
[TP-CONFIG-004] 任务队列必须有界 (error/critical)
使用有界阻塞队列；普通 FIFO 业务可用 ArrayBlockingQueue(capacity)，并显式写出容量；不要使用
LinkedBlockingQueue()（默认 Integer.MAX_VALUE）、PriorityBlockingQueue、DelayedWorkQueue
等无界队列。队列只用来吸收短时突发流量，不是任务仓库存放地。
业务要求优先级时必须保留优先级排序，不能为满足有界约束改成 FIFO。
实现有界优先级 BlockingQueue<Runnable>：按优先级降序、同级提交序号升序取任务；
offer 的容量检查与插入、过载时选择并替换淘汰对象，都必须在同一队列锁内原子完成。
替换操作若已将新任务入队，拒绝处理器须直接返回；不能再次 execute 同一任务造成重复入队或递归淘汰。
ThreadPoolExecutor 接收 BlockingQueue<Runnable>，不是 BlockingQueue<具体任务子类>。

[TP-SHUTDOWN-001] 应用级线程池必须有确定的关闭逻辑 (error/critical)
应用级线程池（字段 / @Bean 形式）必须有确定的关闭逻辑：在应用关闭钩子、@PreDestroy 或
close() 中调用 shutdown()；队列中任务不能丢的业务，还要在关闭前把任务落盘或等待处理完成。

[TP-CONFIG-006] 禁止 DiscardOldestPolicy 与优先级队列组合 (error/medium)
使用 PriorityBlockingQueue 时不要搭配 DiscardOldestPolicy：该策略调用 poll() 丢弃的是
“优先级最高”的任务而不是最旧的任务，会造成重要任务被静默丢掉。
不能通过删除业务优先级来消除此违规。使用有界优先级队列与明确的自定义淘汰规则，
优先级由任务元数据提供；替换必须与正常入队共享同一把锁，避免递归 execute 重试。
如果要求全体排队任务的优先级顺序，避免满队列后新建非核心线程直接执行新任务而绕过队列。

[TP-MONITOR-001] 线程池必须可观测 (warning/medium)
线程池需要可观测：暴露或上报 getQueue().size()、getActiveCount()、getCompletedTaskCount()、
getTaskCount() 以及拒绝次数，并针对队列堆积与拒绝配置监控告警；线程名要能区分业务。
上述 getter 属于 ThreadPoolExecutor。虚拟线程 ExecutorService 没有这些 API，不能强转或直接调用；
应在业务准入与回调完成/异常/finally 路径独立统计 active、completed、failed、rejected，验收真实下游调用。

[TP-CONFIG-002] 最大线程数必须有界 (error/critical)
maximumPoolSize 必须是明确的上界。不要使用 Integer.MAX_VALUE；线程数上界要同时考虑 CPU、内存、
栈大小以及数据库连接池 / 下游接口允许的并发。

[TP-REJECT-001] 必须显式配置拒绝策略 (error/critical)
创建线程池时必须显式写出拒绝策略（第 7 个参数或 setRejectedExecutionHandler），
并按业务语义选择：核心业务用 AbortPolicy 并在调用侧补偿；允许反压的场景用 CallerRunsPolicy；
不要用默认值蒙混过关。

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