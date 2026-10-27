## Case
CASE-012

## 原始任务
给报价服务增加异步能力，下游是阻塞调用，必须隔离到业务线程池并带超时。

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 线程数为什么要和下游容量一起设计？ (source: java-thread-pool-best-practices.md)
不少 I/O 任务最终会访问数据库、Redis 或外部接口。线程池可以让更多任务同时发起调用，却不会增加下游的处理能力。

假设订单服务部署了 4 个实例，每个实例给某项数据库任务配置 40 个线程，理论上可能同时产生 160 个数据库请求。数据库连接池每个实例只有 20 个连接时，大量线程会阻塞在获取连接的位置；数据库本身只能稳定承受 80 个并发查询时，即便继续扩大连接池，也可能把压力转移到数据库。

配置时要从整条调用链分配并发预算：

- 数据库连接要给 Web 请求、定时任务和其他业务线程池预留份额，不能全部交给一个线程池。
- HTTP 客户端连接池的每路由限制和总连接数，应该与实际调用并发匹配。
- 下游有限流阈值时，上游所有实例的并发总和不能长期超过该阈值。
- 一个任务会串行或并行访问多个依赖时，要分别计算每个依赖的占用时间。

线程数增加后，如果活跃连接、获取连接等待时间、下游 P99 和错误率同时上升，继续扩线程通常没有帮助。此时应当减少无效并发，处理慢 SQL、下游超时或热点资源。

### java-thread-pool-best-practices.md § 不要让长任务占满共享线程池 (source: java-thread-pool-best-practices.md)
长时间阻塞的任务会占用工作线程，后续短任务只能排队。报表导出、文件处理和慢外部接口适合使用独立的执行资源，或者改成异步任务并向用户返回任务状态。

`CompletableFuture` 只负责任务编排，不会把阻塞式网络请求变成非阻塞操作。没有显式指定 `Executor` 的异步方法通常使用公共线程池，公共线程池被阻塞后，还可能影响应用中的其他异步任务。

### java-thread-pool-best-practices.md § 使用虚拟线程后还需要传统线程池吗？ (source: java-thread-pool-best-practices.md)
虚拟线程适合包含大量阻塞等待的任务。它创建和切换的成本比平台线程低，通常采用每个任务一个虚拟线程的方式，不要把虚拟线程放进固定大小的池里复用。

需要限制数据库或下游接口并发时，继续使用连接池、`Semaphore`、限流器等机制约束具体资源。虚拟线程数量很多，也不会增加数据库连接数、CPU 核数或下游接口容量。

传统平台线程池仍适用于 CPU 密集型任务、需要固定调度线程的任务，以及必须显式控制平台线程和工作队列的组件。项目是否迁移还要看 JDK 版本、框架支持、监控工具和现有异步模型。详细说明可以参考 [虚拟线程常见问题总结](./virtual-thread.md)。

### java-thread-pool-summary.md § ThreadPoolExecutor 类介绍（重要） (source: java-thread-pool-summary.md)
线程池实现类 `ThreadPoolExecutor` 是 `Executor` 框架最核心的类。

## 当前代码
```java
package com.example.quote.service;

import java.util.concurrent.CompletableFuture;

/** before.java: 使用 CompletableFuture 编排远程报价，但没有指定业务线程池。 */
public class QuoteService {

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture.supplyAsync(() -> remoteQuote(orderId));
    }

    private String remoteQuote(String orderId) {
        return "quote-" + orderId;
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
正常报价结果保持 quote- 加 orderId；本 PoC 的等待上限为 2 秒，超时以 TimeoutException 异常完成 Future；调用方法本身须及时返回。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。