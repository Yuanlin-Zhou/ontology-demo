## Case
CASE-002

## 原始任务
为 OrderSyncService 增加订单数据同步能力，既要保证任务异常可见，也要避免线程上下文串数据。

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