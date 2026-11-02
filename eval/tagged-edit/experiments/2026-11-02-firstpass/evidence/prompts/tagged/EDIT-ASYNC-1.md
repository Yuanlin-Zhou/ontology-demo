## 修改任务
保持 Consumer 构造器、publish 和 stop 公开接口，把同步事件发布改为实例线程池异步发布。固定 1 个工作线程、最多 2 项排队；饱和或关闭后同步抛 RejectedExecutionException。回调失败记录并隔离，不阻止后续事件，stop 等待已接受任务完成，不能静默丢弃。
已知任务条件：下游为阻塞 I/O，不允许在提交线程执行；期望继续复用同一实例线程池。
计划引入的能力：本次新增有界异步缓冲，需要选择队列；本次新增异步提交，需明确过载拒绝；本次新增后台回调，需隔离异常；本次新增线程池，stop 必须等待排空

## 修改涉及的代码实体
eval/tagged-edit/cases/EventPublisher.java#EventPublisher::publish(String)

## 按代码实体标签召回的知识
### tp.create.queue 线程池 / 创建与参数决策 / 任务队列选择决策 [决策知识]
需要有限缓冲时考虑有界 ArrayBlockingQueue 或显式容量 LinkedBlockingQueue；不希望排队时评估 SynchronousQueue 与线程上限、拒绝联动；有优先级需求时评估排序及饥饿风险。PriorityBlockingQueue 的构造容量只是初始容量。根据可接受排队延迟、任务内存、突发量和拒绝行为选容量；未知工作负载先询问或测量，不臆造唯一最佳参数。
关联规则：TP-CONFIG-004, TP-CONFIG-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.create.rejection 线程池 / 创建与参数决策 / 过载与拒绝策略决策 [决策知识]
必须明确任务能否丢失、提交线程能否阻塞、是否需要补偿。AbortPolicy 显式失败并由调用方处理；CallerRunsPolicy 会占用提交线程，Web、锁和事务路径需评估；不能丢的任务应有可观察拒绝和持久补偿方案，禁止用静默丢弃掩盖过载。
关联规则：TP-REJECT-001, TP-REJECT-002, TP-REJECT-003, TP-REJECT-004, TP-REJECT-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.use.exception 线程池 / 使用代码方式 / 任务异常与周期执行 [编码规范]
异常必须可观察；周期回调需在整体任务内保护 RuntimeException，提交外层 catch 不会阻止后续周期被抑制。
关联规则：TP-SUBMIT-005
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.use.shutdown 线程池 / 使用代码方式 / 关闭、重复关闭与等待终止 [编码规范]
停止准入后等待已接受任务；超时强制关闭后再次有界等待，未终止须明确失败。重复或并发关闭也要等待同一结果；处理中断后恢复标志。Java 21 close 本身等待终止。
关联规则：TP-SHUTDOWN-001, TP-SHUTDOWN-002, TP-SHUTDOWN-003
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

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