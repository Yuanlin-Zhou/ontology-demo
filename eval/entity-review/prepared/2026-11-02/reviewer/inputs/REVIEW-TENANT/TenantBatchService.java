import java.util.concurrent.*;
import java.util.function.Function;
interface TenantProcessor {String process(String tenant,String id)throws Exception;}
public class TenantBatchService implements TenantProcessor {
    public static final ThreadLocal<String> TENANT=new ThreadLocal<>();
    private final Function<String,String> downstream;
    private final ThreadPoolExecutor workers=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(8));
    private final ScheduledExecutorService auditScheduler=Executors.newSingleThreadScheduledExecutor();
    public TenantBatchService(Function<String,String> downstream){this.downstream=java.util.Objects.requireNonNull(downstream);}
    public String process(String tenant,String id)throws Exception{
        TENANT.set(tenant);
        return submitWork(tenant,id).get(2,TimeUnit.SECONDS);
    }
    private Future<String> submitWork(String tenant,String id){return workers.submit(()->{TENANT.set(tenant);return TENANT.get()+":"+downstream.apply(id);});}
    public void scheduleAudit(Runnable task){auditScheduler.schedule(task,1,TimeUnit.SECONDS);}
    public void stop()throws InterruptedException{
        workers.shutdown();auditScheduler.shutdown();
        if(!workers.awaitTermination(1,TimeUnit.SECONDS)||!auditScheduler.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");
    }
}
