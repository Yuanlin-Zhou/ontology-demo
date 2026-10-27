## Case
CASE-011

## 原始任务
实时事件推送需要在方法内完成，但不能每个事件都新建线程池。

## Applicable Engineering Rules
[TP-CREATE-002] 不要重复创建线程池 (error/high)
线程池用于复用线程，不要在每次方法调用或每个请求中 new 一个线程池。应用级线程池应作为字段 /
容器 Bean 创建一次；请求级任务提交到共享线程池，或使用独立的、受控的执行资源。

[TP-SHUTDOWN-002] 优雅关闭需等待终止 (error/high)
优雅关闭的标准模式：调用 shutdown()（不再接收新任务，继续处理已提交任务），
然后 awaitTermination(timeout, unit) 等待，超时后调用 shutdownNow() 并再次等待；
Java 21 ExecutorService.close() 自身会等待终止，无需再追加 awaitTermination；
ThreadPoolTaskExecutor 可配置等待任务和终止超时，由容器关闭。只能有一个关闭责任方。
强制关闭后再次等待仍未终止，应向调用者明确报告失败，不能只写日志后正常返回。
重复或并发 stop 也必须等待同一关闭结果，不能因为已有关闭标记就提前返回。

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
PriorityBlockingQueue(capacity) 的 capacity 只是初始容量，不是容量上限。
淘汰最低优先级中最旧任务时按 (priority 最小, sequence 最小) 选择；不能不断覆盖候选而选成最新。
优先级队列 iterator 不保证排序；即使用有序 TreeSet，也不能遇到高优先级元素就 break 而漏掉后面的低优先级候选。

[TP-REJECT-001] 必须显式配置拒绝策略 (error/critical)
创建线程池时必须显式写出拒绝策略（第 7 个参数或 setRejectedExecutionHandler），
并按业务语义选择：核心业务用 AbortPolicy 并在调用侧补偿；允许反压的场景用 CallerRunsPolicy；
不要用默认值蒙混过关。

[TP-SHUTDOWN-001] 应用级线程池必须有确定的关闭逻辑 (error/critical)
应用级线程池（字段 / @Bean 形式）必须有确定的关闭逻辑：在应用关闭钩子、@PreDestroy 或
close() 中调用 shutdown()；队列中任务不能丢的业务，还要在关闭前把任务落盘或等待处理完成。

## 当前代码
```java
package com.example.realtime.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 每次调用都新建线程池（并各自关闭），线程与队列无法复用。 */
public class RealtimePushHandler {

    public void onEvent(String eventId) {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                2, 4, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(50),
                namedFactory("realtime-push"),
                new ThreadPoolExecutor.AbortPolicy());
        try {
            executor.execute(() -> push(eventId));
        } catch (RejectedExecutionException ex) {
            log.warn("push rejected, event={}", eventId, ex);
        } finally {
            executor.shutdown();
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

    private void push(String eventId) {
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
增加公开 RealtimePushHandler(java.util.function.Consumer<String> receiver) 构造器；onEvent 将原始 eventId 交给 receiver，连续调用复用同一个实例线程池。
以上回调是本轮明确的可观察业务边界，不要求实际外网服务。保留原公开无参构造及方法；公开配置构造拒绝 null。无参未配置下游时业务入口同步抛 IllegalStateException，不用空方法或日志伪装业务成功。
业务回调在可观察的实例 ThreadPoolExecutor 工作线程执行；有界队列，原入口异步返回，不在提交线程降级运行回调。回调 RuntimeException 计数且记录日志，不传播到原提交调用者，不阻断后续任务。调用线程原有上下文不变；CASE-002 还须恢复工作线程 TENANT。
提供无参 stats() 返回 Map<String,Long>，包含 submitted（异步入口成功接收）、completed（回调成功）、failed（回调失败）、rejected（饱和或关闭拒绝）；每次入口任务各记一次，reload 不纳入这四项异步入口统计。饱和/关闭时同步抛 RejectedExecutionException 并记录拒绝；CASE-008 同时补偿 SKU。
提供 stop()：停止准入，并等待已接受任务完成；200ms 宽限后可强制关闭，处理未执行任务并再次有界等待，不能终止时明确报错，保留调用者中断标志。关闭后入口明确拒绝。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。