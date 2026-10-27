import java.util.concurrent.*;
public class Harness { public static void main(String[] args) throws Exception {
ExecutorService quick = Executors.newSingleThreadExecutor();
 quick.submit(() -> {} ).get(1, TimeUnit.SECONDS);
 if (!PoolShutdown.stop(quick, 1000) || !quick.isTerminated()) throw new AssertionError("graceful");
 ExecutorService busy = Executors.newSingleThreadExecutor();
 CountDownLatch started = new CountDownLatch(1), stopped = new CountDownLatch(1);
 busy.execute(() -> { started.countDown(); try { Thread.sleep(10000); } catch (InterruptedException e) { } finally { stopped.countDown(); } });
 if (!started.await(1, TimeUnit.SECONDS)) throw new AssertionError("start");
 try { if (PoolShutdown.stop(busy, 50)) throw new AssertionError("timeout result"); if (!stopped.await(1, TimeUnit.SECONDS)) throw new AssertionError("not interrupted"); } finally { busy.shutdownNow(); }
 ExecutorService interrupted = Executors.newSingleThreadExecutor();
 CountDownLatch active = new CountDownLatch(1);
 interrupted.execute(() -> { active.countDown(); try { Thread.sleep(10000); } catch (InterruptedException e) { } });
 active.await(1, TimeUnit.SECONDS);
 try { Thread.currentThread().interrupt(); if (PoolShutdown.stop(interrupted, 1000) || !Thread.currentThread().isInterrupted()) throw new AssertionError("interrupt"); } finally { Thread.interrupted(); interrupted.shutdownNow(); }
System.out.println("PASS");
} }
