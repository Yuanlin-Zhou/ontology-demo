## Case
CASE-006

## 原始任务
紧急任务需要优先处理，过载时丢弃的应该是最旧的任务而不是最重要的任务。

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