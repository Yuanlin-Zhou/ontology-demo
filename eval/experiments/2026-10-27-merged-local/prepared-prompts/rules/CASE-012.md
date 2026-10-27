## Case
CASE-012

## 原始任务
给报价服务增加异步能力，下游是阻塞调用，必须隔离到业务线程池并带超时。

## Applicable Engineering Rules
[TP-SUBMIT-003] CompletableFuture 异步方法必须指定 Executor (error/high)
CompletableFuture.supplyAsync / runAsync / thenApplyAsync 等 *Async 方法必须显式传入业务线程池
（supplyAsync(supplier, executor)），不要依赖公共线程池。

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