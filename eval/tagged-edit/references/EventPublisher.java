import java.util.concurrent.*;
import java.util.function.Consumer;
public class EventPublisher {
    private final Consumer<String> sink;
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new LinkedBlockingQueue<>(2),new ThreadPoolExecutor.AbortPolicy());
    public EventPublisher(Consumer<String> sink){this.sink=java.util.Objects.requireNonNull(sink);}
    public void publish(String message){pool.execute(()->{try{sink.accept(message);}catch(RuntimeException error){error.printStackTrace();}});}
    public void stop()throws InterruptedException{pool.shutdown();if(!pool.awaitTermination(1,TimeUnit.SECONDS))throw new IllegalStateException("not stopped");}
}
