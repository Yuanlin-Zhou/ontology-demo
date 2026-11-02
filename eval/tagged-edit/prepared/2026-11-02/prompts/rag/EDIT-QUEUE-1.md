## 修改任务
保持构造器、send 和 stop 公开接口，把通知服务的任务缓冲限制为最多 2 个排队任务；处理不过来时同步抛 RejectedExecutionException，不能在提交线程降级运行或静默丢弃。保留实际 sink 调用和正常关闭排空行为。
已知任务条件：下游为阻塞 I/O；本次保持单工作线程，允许两项等待任务；调用方能处理显式拒绝。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/BufferedNotifier.java#BufferedNotifier::send(String)

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 不同业务要不要隔离线程池？ (source: java-thread-pool-best-practices.md)
共享线程池会让一类慢任务占用其他业务的执行资源。支付回调、报表导出和普通通知的时效、失败处理方式、依赖资源都不同，放在同一个线程池里很难配置统一的线程数、队列和拒绝策略。

隔离也不是每个接口都创建一个线程池。通常按照任务优先级、耗时特征和下游依赖划分：调用同一个慢服务的任务可以单独隔离；核心交易和非核心通知不共用队列；CPU 密集任务不要和大量阻塞 I/O 任务混在一起。线程池过多会增加线程、队列、监控和配置成本，同类任务可以复用一个池。

现有文章曾引用过一个父子任务共用线程池的事故案例（来源：[线程池运用不当的一次线上事故](https://heapdump.cn/article/646639)）：

![案例代码概览](https://oss.javaguide.cn/github/javaguide/java/concurrent/production-accident-threadpool-sharing-example.png)

假设线程池有 $n$ 个工作线程，同时运行了 $n$ 个父任务。每个父任务提交子任务后，又同步等待子任务结束。子任务进入队列，却没有空闲线程可以执行；父任务不结束，工作线程也不会释放，最终形成线程饥饿死锁。

![线程池使用不当导致死锁](https://oss.javaguide.cn/github/javaguide/java/concurrent/production-accident-threadpool-sharing-deadlock.png)

父任务和它同步等待的子任务不应使用这个有界线程池形成环形等待。可以让父任务直接执行子逻辑、改为不阻塞的任务编排，或者为确实需要隔离的子任务分配独立执行资源。

### java-thread-pool-summary.md § Worker 工作线程机制 (source: java-thread-pool-summary.md)
ThreadPoolExecutor.DiscardOldestPolicy`：此策略将丢弃最早的未处理的任务请求。

举个例子：

举个例子：Spring 通过 `ThreadPoolTaskExecutor` 或者我们直接通过 `ThreadPoolExecutor` 的构造函数创建线程池的时候，当我们不指定 `RejectedExecutionHandler` 拒绝策略来配置线程池的时候，默认使用的是 `AbortPolicy`。在这种拒绝策略下，如果队列满了，`ThreadPoolExecutor` 将抛出 `RejectedExecutionException` 异常来拒绝新来的任务，这代表你将丢失对这个任务的处理。在线程池仍处于运行状态时，`CallerRunsPolicy` 会将被拒绝的任务交给调用者线程执行；线程池已经关闭时，该策略会直接丢弃任务。

```java
public static class CallerRunsPolicy implements RejectedExecutionHandler {

        public CallerRunsPolicy() { }

        public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
            if (!e.isShutdown()) {
                // 直接主线程执行，而不是线程池中的线程执行
                r.run();
            }
        }
    }
```

### java-thread-pool-summary.md § 线程池参数分析 (source: java-thread-pool-summary.md)
`ThreadPoolExecutor` 类中提供的四个构造方法。我们来看最长的那个，其余三个都是在这个构造方法的基础上产生（其他几个构造方法说白点都是给定某些默认参数的构造方法比如默认制定拒绝策略是什么）。

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