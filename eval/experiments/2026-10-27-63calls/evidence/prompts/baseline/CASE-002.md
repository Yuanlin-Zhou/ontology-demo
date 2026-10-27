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
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。