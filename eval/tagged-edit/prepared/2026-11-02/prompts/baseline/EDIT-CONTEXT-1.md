## 修改任务
保持构造器、run、stop 和 TENANT 公开接口及正常返回 tenant:工作结果，修复 run 调用方和复用工作线程的租户上下文泄漏；成功和回调异常后都在对应 finally 恢复原值，原无值时 remove。保留现有线程池容量、等待超时和正常关闭行为。
已知任务条件：同一实例服务多个租户；调用方和工作线程均可能已有不同租户上下文。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/TenantJob.java#TenantJob::run(String,String)

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