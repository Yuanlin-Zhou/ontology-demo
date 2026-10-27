import java.util.concurrent.*;
public class NotificationService implements AutoCloseable {
 private final ThreadPoolExecutor pool = new ThreadPoolExecutor(2, 2, 30L, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16), r -> new Thread(r, "notify-worker"), new ThreadPoolExecutor.AbortPolicy());
 public void notifyCreated(Runnable send) { try { pool.execute(() -> { try { send.run(); } catch (RuntimeException e) { System.err.println("notification failed"); } }); } catch (RejectedExecutionException e) { System.err.println("notification rejected"); } }
 public void close() { pool.shutdown(); try { if (!pool.awaitTermination(2, TimeUnit.SECONDS)) pool.shutdownNow(); } catch (InterruptedException e) { pool.shutdownNow(); Thread.currentThread().interrupt(); } }
}
