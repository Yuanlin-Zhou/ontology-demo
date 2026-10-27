import java.util.concurrent.*;
public class PoolShutdown {
 public static boolean stop(ExecutorService pool, long timeoutMillis) { pool.shutdown(); return true; }
}
