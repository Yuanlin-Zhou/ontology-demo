import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

public class PoolShutdown {

    public static boolean stop(ExecutorService pool, long timeoutMillis) {
        if (pool == null) {
            return true;
        }
        pool.shutdown();
        try {
            if (pool.awaitTermination(timeoutMillis, TimeUnit.MILLISECONDS)) {
                return true;
            }
            pool.shutdownNow();
            return false;
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
            return false;
        }
    }
}