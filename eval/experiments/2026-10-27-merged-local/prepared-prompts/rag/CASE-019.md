## Case
CASE-019

## 原始任务
为订单金额计算补充价格相关逻辑，不需要线程池。

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

### java-thread-pool-summary.md § `Runnable` vs `Callable` (source: java-thread-pool-summary.md)
`Runnable` 自 Java 1.0 以来一直存在，但 `Callable` 仅在 Java 1.5 中引入，目的就是为了来处理 `Runnable` 不支持的用例。`Runnable` 接口不会返回结果或抛出检查异常，但是 `Callable` 接口可以。所以，如果任务不需要返回结果或抛出异常推荐使用 `Runnable` 接口，这样代码看起来会更加简洁。

工具类 `Executors` 可以实现将 `Runnable` 对象转换成 `Callable` 对象。（`Executors.callable(Runnable task)` 或 `Executors.callable(Runnable task, Object result)`）。

`Runnable.java`

```java
@FunctionalInterface
public interface Runnable {
   /**
    * 被线程执行，没有返回值也无法抛出异常
    */
    public abstract void run();
}
```

`Callable.java`

```java
@FunctionalInterface
public interface Callable<V> {
    /**
     * 计算结果，或在无法这样做时抛出异常。
     * @return 计算得出的结果
     * @throws 如果无法计算结果，则抛出异常
     */
    V call() throws Exception;
}

```

### java-thread-pool-best-practices.md § 线程数为什么要和下游容量一起设计？ (source: java-thread-pool-best-practices.md)
不少 I/O 任务最终会访问数据库、Redis 或外部接口。线程池可以让更多任务同时发起调用，却不会增加下游的处理能力。

假设订单服务部署了 4 个实例，每个实例给某项数据库任务配置 40 个线程，理论上可能同时产生 160 个数据库请求。数据库连接池每个实例只有 20 个连接时，大量线程会阻塞在获取连接的位置；数据库本身只能稳定承受 80 个并发查询时，即便继续扩大连接池，也可能把压力转移到数据库。

配置时要从整条调用链分配并发预算：

- 数据库连接要给 Web 请求、定时任务和其他业务线程池预留份额，不能全部交给一个线程池。
- HTTP 客户端连接池的每路由限制和总连接数，应该与实际调用并发匹配。
- 下游有限流阈值时，上游所有实例的并发总和不能长期超过该阈值。
- 一个任务会串行或并行访问多个依赖时，要分别计算每个依赖的占用时间。

线程数增加后，如果活跃连接、获取连接等待时间、下游 P99 和错误率同时上升，继续扩线程通常没有帮助。此时应当减少无效并发，处理慢 SQL、下游超时或热点资源。

## 当前代码
```java
package com.example.order.domain;

import java.math.BigDecimal;
import java.util.List;

/** before.java: 负样本 —— 纯业务计算代码，没有任何并发语义。 */
public class OrderAmountCalculator {

    private static final BigDecimal VIP_DISCOUNT = new BigDecimal("0.95");

    public BigDecimal total(List<OrderItem> items, boolean vip) {
        BigDecimal total = BigDecimal.ZERO;
        for (OrderItem item : items) {
            total = total.add(item.price().multiply(BigDecimal.valueOf(item.quantity())));
        }
        return vip ? total.multiply(VIP_DISCOUNT) : total;
    }

    public record OrderItem(String sku, BigDecimal price, int quantity) {
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
保留 OrderItem record 和 total(List<OrderItem>, boolean) 的金额与 VIP 折扣行为。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。