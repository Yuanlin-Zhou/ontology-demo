## 修改任务
保持 Consumer 构造器、publish 和 stop 公开接口，把同步事件发布改为实例线程池异步发布。固定 1 个工作线程、最多 2 项排队；饱和或关闭后同步抛 RejectedExecutionException。回调失败记录并隔离，不阻止后续事件，stop 等待已接受任务完成，不能静默丢弃。
已知任务条件：下游为阻塞 I/O，不允许在提交线程执行；期望继续复用同一实例线程池。
计划引入的能力：本次新增有界异步缓冲，需要选择队列；本次新增异步提交，需明确过载拒绝；本次新增后台回调，需隔离异常；本次新增线程池，stop 必须等待排空

## 修改涉及的代码实体
eval/tagged-edit/cases/EventPublisher.java#EventPublisher::publish(String)

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