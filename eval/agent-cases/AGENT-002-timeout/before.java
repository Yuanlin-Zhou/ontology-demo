import java.util.concurrent.*;
public class TimedQuery {
 public static String query(ExecutorService pool, Callable<String> work, long timeoutMillis) {
  try { return pool.submit(work).get(); } catch (Exception e) { return "failed"; }
 }
}
