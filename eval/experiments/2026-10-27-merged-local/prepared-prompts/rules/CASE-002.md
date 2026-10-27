## Case
CASE-002

## 原始任务
为 OrderSyncService 增加订单数据同步能力，既要保证任务异常可见，也要避免线程上下文串数据。

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

[TP-SUBMIT-004] ThreadLocal 必须在 finally 中清理 (error/critical)
线程池复用线程，任务中 set 过的 ThreadLocal / MDC（登录信息、租户、traceId）必须在 finally 中
remove 或恢复原值；跨线程传递场景使用统一的任务包装器或 TransmittableThreadLocal。

[TP-REJECT-003] 必须处理 RejectedExecutionException (error/high)
当线程池使用 AbortPolicy（默认）时，submit/execute 必须放在 try/catch 中捕获
RejectedExecutionException，并做补偿：重试、持久化后补偿、降级或快速失败返回业务错误码。

[TP-CREATE-003] 线程池必须配置线程工厂 (warning/high)
创建线程池时要显式传入 ThreadFactory，让线程名带上业务前缀（如 order-query-3）。
可以使用 new ThreadPoolTaskExecutor() 的 setThreadNamePrefix，或自定义 ThreadFactory。

[TP-CONFIG-002] 最大线程数必须有界 (error/critical)
maximumPoolSize 必须是明确的上界。不要使用 Integer.MAX_VALUE；线程数上界要同时考虑 CPU、内存、
栈大小以及数据库连接池 / 下游接口允许的并发。

## 当前代码
```java
package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * before.java: 数据同步任务，使用 ThreadLocal 传递租户，并直接 get() 等待结果。
 */
public class OrderSyncService {

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private final ExecutorService syncExecutor = Executors.newFixedThreadPool(8);

    public void syncCreated(Order order) {
        syncExecutor.submit(() -> {
            TENANT.set(order.tenantId());
            syncRemote(order);
        });
    }

    public Order reload(String id) throws Exception {
        Future<Order> future = syncExecutor.submit(() -> query(id));
        return future.get();
    }

    private void syncRemote(Order order) {
        // remote call
    }

    private Order query(String id) {
        return null;
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
订单输入类型为 com.example.order.domain.Order(String id, String tenantId)；保留已有 TENANT 上下文字段。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。