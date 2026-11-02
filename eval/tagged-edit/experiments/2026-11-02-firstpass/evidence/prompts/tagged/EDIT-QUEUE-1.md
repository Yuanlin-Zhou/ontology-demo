## 修改任务
保持构造器、send 和 stop 公开接口，把通知服务的任务缓冲限制为最多 2 个排队任务；处理不过来时同步抛 RejectedExecutionException，不能在提交线程降级运行或静默丢弃。保留实际 sink 调用和正常关闭排空行为。
已知任务条件：下游为阻塞 I/O；本次保持单工作线程，允许两项等待任务；调用方能处理显式拒绝。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/BufferedNotifier.java#BufferedNotifier::send(String)

## 按代码实体标签召回的知识
### tp.use.result 线程池 / 使用代码方式 / 提交方式与结果消费 [编码规范]
无需结果时 execute 并处理任务异常；submit 会封装异常，必须消费结果或明确转交结果责任，局部赋值不等于结果被处理。
关联规则：TP-SUBMIT-001
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.use.exception 线程池 / 使用代码方式 / 任务异常与周期执行 [编码规范]
异常必须可观察；周期回调需在整体任务内保护 RuntimeException，提交外层 catch 不会阻止后续周期被抑制。
关联规则：TP-SUBMIT-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.create.workload 线程池 / 创建与参数决策 / 任务类型与线程模型 [决策知识]
先区分 CPU 密集、阻塞 I/O、周期任务与下游并发限制。CPU 工作从可用核数起步并压测；阻塞 I/O 根据等待比例及下游容量评估；虚拟线程仍要限制下游并发，不能把线程轻量等同无限资源。
关联规则：需结合任务条件判断
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.create.explicit 线程池 / 创建与参数决策 / 显式配置与生命周期归属 [编码规范]
显式配置池、队列与拒绝行为，避免请求内重复建池。明确实例或容器的唯一生命周期责任方；标准快捷工厂可能隐藏无界资源。
关联规则：TP-CREATE-001, TP-CREATE-002, TP-CREATE-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.create.sizing 线程池 / 创建与参数决策 / 线程数与空闲回收决策 [决策知识]
先确定吞吐、任务耗时、突发流量及下游并发上限，再选择核心数和最大数。队列未满时通常不会扩到最大线程数；空闲回收要结合 keepAlive 与核心线程超时配置，用实际负载观察而非套固定公式。
关联规则：TP-CONFIG-001, TP-CONFIG-002, TP-CONFIG-003
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.create.queue 线程池 / 创建与参数决策 / 任务队列选择决策 [决策知识]
需要有限缓冲时考虑有界 ArrayBlockingQueue 或显式容量 LinkedBlockingQueue；不希望排队时评估 SynchronousQueue 与线程上限、拒绝联动；有优先级需求时评估排序及饥饿风险。PriorityBlockingQueue 的构造容量只是初始容量。根据可接受排队延迟、任务内存、突发量和拒绝行为选容量；未知工作负载先询问或测量，不臆造唯一最佳参数。
关联规则：TP-CONFIG-004, TP-CONFIG-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

## 当前代码
```java
import java.util.concurrent.*;
import java.util.function.Consumer;
public class BufferedNotifier {
    private final Consumer<String> sink;
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new LinkedBlockingQueue<>(),new ThreadPoolExecutor.AbortPolicy());
    public BufferedNotifier(Consumer<String> sink){this.sink=java.util.Objects.requireNonNull(sink);}
    public void send(String message){pool.execute(()->sink.accept(message));}
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
```

## 统一交付约定
输出完整单个 Java 源文件，使用 JDK 21 标准库；保留任务指定的公开接口及无关业务。实际执行注入的回调，不用空实现、日志或测试替身冒充业务。只实现本次明确修改。不要输出解释。