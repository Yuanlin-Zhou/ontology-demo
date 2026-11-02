## 修改任务
保持构造器、run、stop 和 TENANT 公开接口及正常返回 tenant:工作结果，修复 run 调用方和复用工作线程的租户上下文泄漏；成功和回调异常后都在对应 finally 恢复原值，原无值时 remove。保留现有线程池容量、等待超时和正常关闭行为。
已知任务条件：同一实例服务多个租户；调用方和工作线程均可能已有不同租户上下文。
计划引入的能力：按现有实体完成指定修改

## 修改涉及的代码实体
eval/tagged-edit/cases/TenantJob.java#TenantJob::run(String,String)

## 按代码实体标签召回的知识
### tp.use.context 线程池 / 使用代码方式 / 调用方与工作线程上下文恢复 [编码规范]
捕获原上下文，在当前执行路径的 finally 中恢复旧值或 remove；同时检查调用方与工作线程，延迟 lambda 中的 remove 不是已经清理。
关联规则：TP-SUBMIT-004
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.use.result 线程池 / 使用代码方式 / 提交方式与结果消费 [编码规范]
无需结果时 execute 并处理任务异常；submit 会封装异常，必须消费结果或明确转交结果责任，局部赋值不等于结果被处理。
关联规则：TP-SUBMIT-001
来源：java-thread-pool-summary.md, java-thread-pool-best-practices.md

### tp.use.timeout 线程池 / 使用代码方式 / 等待超时与实际任务取消 [编码规范]
等待应有超时。超时不代表任务停止，保留实际执行句柄并验证中断响应；取消排队任务时移除实际入队 Runnable，不能用内部 FutureTask 移除外层包装器；关闭还要完成等待结果。
关联规则：TP-SUBMIT-002
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