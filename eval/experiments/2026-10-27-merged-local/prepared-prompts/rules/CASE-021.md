## Case
CASE-021

## 原始任务
用 @Bean 暴露订单通知线程池，需要保证容器关闭时线程池被回收、任务异常可见。

## Applicable Engineering Rules
[TP-REJECT-003] 必须处理 RejectedExecutionException (error/high)
当线程池使用 AbortPolicy（默认）时，submit/execute 必须放在 try/catch 中捕获
RejectedExecutionException，并做补偿：重试、持久化后补偿、降级或快速失败返回业务错误码。

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

[TP-REJECT-001] 必须显式配置拒绝策略 (error/critical)
创建线程池时必须显式写出拒绝策略（第 7 个参数或 setRejectedExecutionHandler），
并按业务语义选择：核心业务用 AbortPolicy 并在调用侧补偿；允许反压的场景用 CallerRunsPolicy；
不要用默认值蒙混过关。

## 当前代码
```java
package com.example.config;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** before.java: 通过 @Bean 暴露裸 ThreadPoolExecutor，但没有 @PreDestroy 关闭。 */
@Configuration
public class NotifyExecutorConfig {

    @Bean("orderNotifier")
    public ThreadPoolExecutor orderNotifier() {
        return new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(200),
                namedFactory("order-notify"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void dispatch(ThreadPoolExecutor notifier, String orderId) {
        notifier.execute(() -> {
            if (orderId == null) {
                throw new IllegalArgumentException("orderId is null");
            }
            send(orderId);
        });
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private void send(String orderId) {
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
Spring 线程池 Bean 名保持 orderNotifier。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。