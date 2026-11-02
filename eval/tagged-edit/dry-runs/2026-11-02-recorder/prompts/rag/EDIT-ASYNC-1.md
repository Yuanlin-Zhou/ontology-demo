## 修改任务
保持 Consumer 构造器、publish 和 stop 公开接口，把同步事件发布改为实例线程池异步发布。固定 1 个工作线程、最多 2 项排队；饱和或关闭后同步抛 RejectedExecutionException。回调失败记录并隔离，不阻止后续事件，stop 等待已接受任务完成，不能静默丢弃。
已知任务条件：下游为阻塞 I/O，不允许在提交线程执行；期望继续复用同一实例线程池。
计划引入的能力：本次新增有界异步缓冲，需要选择队列；本次新增异步提交，需明确过载拒绝；本次新增后台回调，需隔离异常；本次新增线程池，stop 必须等待排空

## 修改涉及的代码实体
eval/tagged-edit/cases/EventPublisher.java#EventPublisher::publish(String)

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 不同业务要不要隔离线程池？ (source: java-thread-pool-best-practices.md)
共享线程池会让一类慢任务占用其他业务的执行资源。支付回调、报表导出和普通通知的时效、失败处理方式、依赖资源都不同，放在同一个线程池里很难配置统一的线程数、队列和拒绝策略。

隔离也不是每个接口都创建一个线程池。通常按照任务优先级、耗时特征和下游依赖划分：调用同一个慢服务的任务可以单独隔离；核心交易和非核心通知不共用队列；CPU 密集任务不要和大量阻塞 I/O 任务混在一起。线程池过多会增加线程、队列、监控和配置成本，同类任务可以复用一个池。

现有文章曾引用过一个父子任务共用线程池的事故案例（来源：[线程池运用不当的一次线上事故](https://heapdump.cn/article/646639)）：

![案例代码概览](https://oss.javaguide.cn/github/javaguide/java/concurrent/production-accident-threadpool-sharing-example.png)

假设线程池有 $n$ 个工作线程，同时运行了 $n$ 个父任务。每个父任务提交子任务后，又同步等待子任务结束。子任务进入队列，却没有空闲线程可以执行；父任务不结束，工作线程也不会释放，最终形成线程饥饿死锁。

![线程池使用不当导致死锁](https://oss.javaguide.cn/github/javaguide/java/concurrent/production-accident-threadpool-sharing-deadlock.png)

父任务和它同步等待的子任务不应使用这个有界线程池形成环形等待。可以让父任务直接执行子逻辑、改为不阻塞的任务编排，或者为确实需要隔离的子任务分配独立执行资源。

### java-thread-pool-best-practices.md § CallerRunsPolicy 能形成背压吗？ (source: java-thread-pool-best-practices.md)
`CallerRunsPolicy` 会让调用 `execute()` 的线程执行被拒绝的任务。提交线程因此变慢，后续任务的提交速度也可能下降，所以它具备一定的反馈调节作用。

效果取决于提交者是谁。消息消费线程或批处理调度线程被迫执行任务时，上游拉取速度可能自然下降；Tomcat 请求线程执行长任务时，请求线程会被占住，接口延迟和请求线程池压力也会增加。提交线程持有锁或数据库事务时，任务在调用线程执行还会延长锁和事务的占用时间。

线程池关闭后，`CallerRunsPolicy` 不会再执行任务，而是直接丢弃。业务不能接受丢任务时，需要自定义拒绝处理：记录拒绝次数，返回明确失败，或者把任务写入可靠存储。不要只换一个拒绝策略，就把任务可靠性问题留给调用方。

### java-thread-pool-summary.md § 线程池参数分析 (source: java-thread-pool-summary.md)
`ThreadPoolExecutor` 类中提供的四个构造方法。我们来看最长的那个，其余三个都是在这个构造方法的基础上产生（其他几个构造方法说白点都是给定某些默认参数的构造方法比如默认制定拒绝策略是什么）。

## 当前代码
```java
import java.util.function.Consumer;
public class EventPublisher {
    private final Consumer<String> receiver;
    public EventPublisher(Consumer<String> receiver){this.receiver=java.util.Objects.requireNonNull(receiver);}
    public void publish(String event){receiver.accept(event);}
    public void stop(){}
}
```

## 统一交付约定
输出完整单个 Java 源文件，使用 JDK 21 标准库；保留任务指定的公开接口及无关业务。实际执行注入的回调，不用空实现、日志或测试替身冒充业务。只实现本次明确修改。不要输出解释。