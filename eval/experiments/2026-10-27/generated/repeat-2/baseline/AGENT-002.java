import java.util.concurrent.*;

public class TimedQuery {
    public static String query(ExecutorService pool, Callable<String> work, long timeoutMillis) {
        Future<String> future = pool.submit(work);
        try {
            return future.get(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            return "timeout";
        } catch (InterruptedException e) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            return "interrupted";
        } catch (ExecutionException e) {
            return "failed";
        } catch (CancellationException e) {
            return "failed";
        }
    }
}