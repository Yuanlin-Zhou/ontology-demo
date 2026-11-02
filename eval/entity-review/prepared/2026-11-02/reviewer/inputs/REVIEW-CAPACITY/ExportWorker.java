import java.util.concurrent.*;
import java.util.function.Consumer;
public class ExportWorker {
    private final Consumer<String> sink;
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(1,8,30,TimeUnit.SECONDS,new LinkedBlockingQueue<>(),new ThreadPoolExecutor.AbortPolicy());
    private static final ThreadLocal<String> AUDIT=new ThreadLocal<>();
    public ExportWorker(Consumer<String> sink){this.sink=java.util.Objects.requireNonNull(sink);}
    public void export(String id){pool.execute(()->sink.accept(id));}
    public void audit(String trace){AUDIT.set(trace);try{System.out.println(trace);}finally{AUDIT.remove();}}
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
