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
