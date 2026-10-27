import java.util.concurrent.*;
public class TimedQuery {
 public static String query(ExecutorService pool, Callable<String> work, long timeoutMillis) {
  Future<String> f = pool.submit(work);
  try { return f.get(timeoutMillis, TimeUnit.MILLISECONDS); }
  catch (TimeoutException e) { f.cancel(true); return "timeout"; }
  catch (InterruptedException e) { f.cancel(true); Thread.currentThread().interrupt(); return "interrupted"; }
  catch (ExecutionException e) { return "failed"; }
 }
}
