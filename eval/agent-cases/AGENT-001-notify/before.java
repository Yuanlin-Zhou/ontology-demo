import java.util.concurrent.*;
public class NotificationService implements AutoCloseable {
 private final ExecutorService pool = Executors.newFixedThreadPool(2);
 public void notifyCreated(Runnable send) { pool.execute(send); }
 public void close() { pool.shutdown(); }
}
