import java.util.concurrent.*;
import java.util.function.Function;
public class TenantJob {
    public static final ThreadLocal<String> TENANT=new ThreadLocal<>();
    private final Function<String,String> work;
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));
    public TenantJob(Function<String,String> work){this.work=java.util.Objects.requireNonNull(work);}
    public String run(String tenant,String payload)throws Exception{
        String caller=TENANT.get();
        try{TENANT.set(tenant);
        Future<String> result=pool.submit(()->{String previous=TENANT.get();try{TENANT.set(tenant);return TENANT.get()+":"+work.apply(payload);}finally{restore(previous);}});
        return result.get(2,TimeUnit.SECONDS);}finally{restore(caller);}
    }
    private static void restore(String value){if(value==null)TENANT.remove();else TENANT.set(value);}
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
