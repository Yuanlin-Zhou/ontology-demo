## 修改任务
保持构造器、send 和 stop 公开接口，把通知服务的任务缓冲限制为最多 2 个排队任务；处理不过来时同步抛 RejectedExecutionException，不能在提交线程降级运行或静默丢弃。保留实际 sink 调用和正常关闭排空行为。
已知任务条件：下游为阻塞 I/O；本次保持单工作线程，允许两项等待任务；调用方能处理显式拒绝。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/BufferedNotifier.java#BufferedNotifier::send(String)

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