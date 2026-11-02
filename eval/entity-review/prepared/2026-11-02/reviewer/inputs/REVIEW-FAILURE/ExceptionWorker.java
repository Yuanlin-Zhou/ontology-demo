import java.util.concurrent.*;
import java.util.function.Consumer;
public class ExceptionWorker {
    private final Consumer<String> callback;
    private final ThreadPoolExecutor worker=new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(8),r->new Thread(r,"delivery-worker"),new ThreadPoolExecutor.AbortPolicy());
    public ExceptionWorker(Consumer<String> callback){this.callback=java.util.Objects.requireNonNull(callback);}
    public void deliver(String value){worker.execute(()->{try{callback.accept(value);}catch(RuntimeException error){}});}
    public long completed(){return worker.getCompletedTaskCount();}
    public void stop()throws InterruptedException{worker.shutdown();if(!worker.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
