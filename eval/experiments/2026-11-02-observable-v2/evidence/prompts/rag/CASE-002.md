## Case
CASE-002

## 原始任务
为 OrderSyncService 增加订单数据同步能力，既要保证任务异常可见，也要避免线程上下文串数据。

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 清理线程上下文 (source: java-thread-pool-best-practices.md)
线程池会复用线程。前一个任务写入 `ThreadLocal` 后没有清理，后续任务可能在同一线程上读到旧值，还可能让大对象长期被工作线程引用。

上下文传递和清理应由统一的任务包装器处理，在 `finally` 中恢复或删除原值。日志 MDC、登录信息和租户信息都要考虑这个问题。跨线程传递场景也可以使用 [TransmittableThreadLocal](https://github.com/alibaba/transmittable-thread-local)，但仍要确认包装方式和清理时机。

### java-thread-pool-best-practices.md § 异步任务的异常为什么容易丢？ (source: java-thread-pool-best-practices.md)
通过 `execute()` 提交的 `Runnable` 抛出未捕获异常时，工作线程会异常结束，可以由线程的 `UncaughtExceptionHandler` 记录。通过 `submit()` 提交时，任务通常被包装成 `FutureTask`，异常保存在返回的 `Future` 中；调用方既不保存 `Future`，也不调用 `get()`，异常就可能没有业务日志。

`ThreadPoolExecutor.afterExecute()` 也有同样的区别。使用 `submit()` 时，传给 `afterExecute()` 的 `Throwable` 通常是 `null`，需要判断任务是否为已经完成的 `Future`，再通过 `get()` 取得异常。

异常处理方式最好在项目内统一：调用方消费 `Future`，任务入口主动捕获并记录异常，或者扩展线程池集中处理。日志要带上任务类型、业务 ID 和 Trace ID，不能只打印一段脱离业务的堆栈。

### java-thread-pool-best-practices.md § 线程数为什么要和下游容量一起设计？ (source: java-thread-pool-best-practices.md)
不少 I/O 任务最终会访问数据库、Redis 或外部接口。线程池可以让更多任务同时发起调用，却不会增加下游的处理能力。

假设订单服务部署了 4 个实例，每个实例给某项数据库任务配置 40 个线程，理论上可能同时产生 160 个数据库请求。数据库连接池每个实例只有 20 个连接时，大量线程会阻塞在获取连接的位置；数据库本身只能稳定承受 80 个并发查询时，即便继续扩大连接池，也可能把压力转移到数据库。

配置时要从整条调用链分配并发预算：

- 数据库连接要给 Web 请求、定时任务和其他业务线程池预留份额，不能全部交给一个线程池。
- HTTP 客户端连接池的每路由限制和总连接数，应该与实际调用并发匹配。
- 下游有限流阈值时，上游所有实例的并发总和不能长期超过该阈值。
- 一个任务会串行或并行访问多个依赖时，要分别计算每个依赖的占用时间。

线程数增加后，如果活跃连接、获取连接等待时间、下游 P99 和错误率同时上升，继续扩线程通常没有帮助。此时应当减少无效并发，处理慢 SQL、下游超时或热点资源。

### java-thread-pool-summary.md § ThreadPoolExecutor 类介绍（重要） (source: java-thread-pool-summary.md)
线程池实现类 `ThreadPoolExecutor` 是 `Executor` 框架最核心的类。

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
增加公开 OrderSyncService(java.util.function.Consumer<com.example.order.domain.Order> synchronizer, java.util.function.Function<String,com.example.order.domain.Order> loader) 构造器。syncCreated 传原始 Order，回调内 TENANT=order.tenantId，finally 恢复工作线程原值（原来无值则 remove）。reload 在业务线程池调用 loader，使用带超时的 Future 等待并返回 loader 原始结果，超时/调用者中断取消实际任务并保留异常原因和中断状态。
以上回调是本轮明确的可观察业务边界，不要求实际外网服务。保留原公开无参构造及方法；公开配置构造拒绝 null。无参未配置下游时业务入口同步抛 IllegalStateException，不用空方法或日志伪装业务成功。
业务回调在可观察的实例 ThreadPoolExecutor 工作线程执行；有界队列，原入口异步返回，不在提交线程降级运行回调。回调 RuntimeException 计数且记录日志，不传播到原提交调用者，不阻断后续任务。调用线程原有上下文不变；CASE-002 还须恢复工作线程 TENANT。
提供无参 stats() 返回 Map<String,Long>，包含 submitted（异步入口成功接收）、completed（回调成功）、failed（回调失败）、rejected（饱和或关闭拒绝）；每次入口任务各记一次，reload 不纳入这四项异步入口统计。饱和/关闭时同步抛 RejectedExecutionException 并记录拒绝；CASE-008 同时补偿 SKU。
提供 stop()：停止准入，并等待已接受任务完成；200ms 宽限后可强制关闭，处理未执行任务并再次有界等待，不能终止时明确报错，保留调用者中断标志。关闭后入口明确拒绝。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。