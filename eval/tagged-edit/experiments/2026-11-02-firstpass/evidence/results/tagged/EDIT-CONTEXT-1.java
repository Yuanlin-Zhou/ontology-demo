import java.util.concurrent.*;
import java.util.function.Function;
public class TenantJob {
    public static final ThreadLocal<String> TENANT=new ThreadLocal<>();
    private final Function<String,String> work;
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));
    public TenantJob(Function<String,String> work){this.work=java.util.Objects.requireNonNull(work);}
    public String run(String tenant,String payload)throws Exception{
        String callerPrev=TENANT.get();
        TENANT.set(tenant);
        try{
            Future<String> result=pool.submit(()->{
                String workerPrev=TENANT.get();
                TENANT.set(tenant);
                try{
                    return TENANT.get()+":"+work.apply(payload);
                }finally{
                    if(workerPrev==null)TENANT.remove();else TENANT.set(workerPrev);
                }
            });
            return result.get(2,TimeUnit.SECONDS);
        }finally{
            if(callerPrev==null)TENANT.remove();else TENANT.set(callerPrev);
        }
    }
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}