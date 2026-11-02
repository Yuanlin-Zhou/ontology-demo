## 修改任务
保持构造器、run、stop 和 TENANT 公开接口及正常返回 tenant:工作结果，修复 run 调用方和复用工作线程的租户上下文泄漏；成功和回调异常后都在对应 finally 恢复原值，原无值时 remove。保留现有线程池容量、等待超时和正常关闭行为。
已知任务条件：同一实例服务多个租户；调用方和工作线程均可能已有不同租户上下文。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/TenantJob.java#TenantJob::run(String,String)

## Retrieved Knowledge (RAG)
### java-thread-pool-best-practices.md § 清理线程上下文 (source: java-thread-pool-best-practices.md)
线程池会复用线程。前一个任务写入 `ThreadLocal` 后没有清理，后续任务可能在同一线程上读到旧值，还可能让大对象长期被工作线程引用。

上下文传递和清理应由统一的任务包装器处理，在 `finally` 中恢复或删除原值。日志 MDC、登录信息和租户信息都要考虑这个问题。跨线程传递场景也可以使用 [TransmittableThreadLocal](https://github.com/alibaba/transmittable-thread-local)，但仍要确认包装方式和清理时机。

### java-thread-pool-summary.md § `Runnable` vs `Callable` (source: java-thread-pool-summary.md)
`Runnable` 自 Java 1.0 以来一直存在，但 `Callable` 仅在 Java 1.5 中引入，目的就是为了来处理 `Runnable` 不支持的用例。`Runnable` 接口不会返回结果或抛出检查异常，但是 `Callable` 接口可以。所以，如果任务不需要返回结果或抛出异常推荐使用 `Runnable` 接口，这样代码看起来会更加简洁。

工具类 `Executors` 可以实现将 `Runnable` 对象转换成 `Callable` 对象。（`Executors.callable(Runnable task)` 或 `Executors.callable(Runnable task, Object result)`）。

`Runnable.java`

```java
@FunctionalInterface
public interface Runnable {
   /**
    * 被线程执行，没有返回值也无法抛出异常
    */
    public abstract void run();
}
```

`Callable.java`

```java
@FunctionalInterface
public interface Callable<V> {
    /**
     * 计算结果，或在无法这样做时抛出异常。
     * @return 计算得出的结果
     * @throws 如果无法计算结果，则抛出异常
     */
    V call() throws Exception;
}

```

### java-thread-pool-best-practices.md § 线程数为什么要和下游容量一起设计？ (source: java-thread-pool-best-practices.md)
不少 I/O 任务最终会访问数据库、Redis 或外部接口。线程池可以让更多任务同时发起调用，却不会增加下游的处理能力。

假设订单服务部署了 4 个实例，每个实例给某项数据库任务配置 40 个线程，理论上可能同时产生 160 个数据库请求。数据库连接池每个实例只有 20 个连接时，大量线程会阻塞在获取连接的位置；数据库本身只能稳定承受 80 个并发查询时，即便继续扩大连接池，也可能把压力转移到数据库。

配置时要从整条调用链分配并发预算：

- 数据库连接要给 Web 请求、定时任务和其他业务线程池预留份额，不能全部交给一个线程池。
- HTTP 客户端连接池的每路由限制和总连接数，应该与实际调用并发匹配。
- 下游有限流阈值时，上游所有实例的并发总和不能长期超过该阈值。
- 一个任务会串行或并行访问多个依赖时，要分别计算每个依赖的占用时间。

线程数增加后，如果活跃连接、获取连接等待时间、下游 P99 和错误率同时上升，继续扩线程通常没有帮助。此时应当减少无效并发，处理慢 SQL、下游超时或热点资源。

## 当前代码
```java
import java.util.concurrent.*;
import java.util.function.Function;
public class TenantJob {
    public static final ThreadLocal<String> TENANT=new ThreadLocal<>();
    private final Function<String,String> work;
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));
    public TenantJob(Function<String,String> work){this.work=java.util.Objects.requireNonNull(work);}
    public String run(String tenant,String payload)throws Exception{
        TENANT.set(tenant);
        Future<String> result=pool.submit(()->{TENANT.set(tenant);return TENANT.get()+":"+work.apply(payload);});
        return result.get(2,TimeUnit.SECONDS);
    }
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
```

## 统一交付约定
输出完整单个 Java 源文件，使用 JDK 21 标准库；保留任务指定的公开接口及无关业务。实际执行注入的回调，不用空实现、日志或测试替身冒充业务。只实现本次明确修改。不要输出解释。