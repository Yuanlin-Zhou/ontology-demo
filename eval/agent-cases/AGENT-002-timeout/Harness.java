import java.util.concurrent.*;
public class Harness { public static void main(String[] args) throws Exception {
ExecutorService pool = Executors.newSingleThreadExecutor();
 try {
  if (!"ok".equals(TimedQuery.query(pool, () -> "ok", 1000))) throw new AssertionError("success");
  if (!"failed".equals(TimedQuery.query(pool, () -> { throw new Exception("fail"); }, 1000))) throw new AssertionError("exception");
  CountDownLatch stopped = new CountDownLatch(1);
  if (!"timeout".equals(TimedQuery.query(pool, () -> { try { Thread.sleep(10000); } finally { stopped.countDown(); } return "late"; }, 200))) throw new AssertionError("timeout");
  if (!stopped.await(1, TimeUnit.SECONDS)) throw new AssertionError("not cancelled");
  Thread.currentThread().interrupt();
  if (!"interrupted".equals(TimedQuery.query(pool, () -> "x", 1000)) || !Thread.currentThread().isInterrupted()) throw new AssertionError("interrupt lost");
  Thread.interrupted();
  if (pool.isShutdown()) throw new AssertionError("caller pool closed");
 } finally { Thread.interrupted(); pool.shutdownNow(); }
System.out.println("PASS");
} }
