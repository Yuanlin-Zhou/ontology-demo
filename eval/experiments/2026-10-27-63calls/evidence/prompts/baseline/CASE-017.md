## Case
CASE-017

## 原始任务
用虚拟线程改造阻塞式下游通知，同时不能让下游连接被打满。

## 当前代码
```java
package com.example.loom.service;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** before.java: 使用虚拟线程执行阻塞式下游调用。 */
public class LoomNotifier {

    private final ExecutorService virtualExecutor = Executors.newVirtualThreadPerTaskExecutor();

    public void notify(String orderId) {
        virtualExecutor.execute(() -> remoteNotify(orderId));
    }

    private void remoteNotify(String orderId) {
        // 阻塞式 HTTP 调用
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
保留公开无参构造及 notify(String)；增加公开 LoomNotifier(int maxConcurrent, java.util.function.Consumer<String> downstream) 构造器以注入真实下游。实际回调必须在虚拟线程执行，notify 在下游阻塞时也须及时返回。并发上限在每个实例内生效，提交前快速准入；已满或关闭时同步抛 RejectedExecutionException，不能创建无限等待任务或静默丢弃。正常完成、下游异常、工作线程中断以及启动失败均释放已获取许可；回调异常需要记录且不能阻断后续通知。stats() 返回 Map<String,Long>，提供 active（已接受未结束）、completed（成功）、failed（回调失败）、rejected（每个拒绝请求计一次）。stop() 停止接收并等待已接收通知结束，超时/中断须明确报告；保留调用方中断标志，不在调用线程降级执行下游。
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。