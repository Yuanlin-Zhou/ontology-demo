import java.util.concurrent.*;
public class Harness { public static void main(String[] args) throws Exception {
NotificationService s = new NotificationService();
 CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), done = new CountDownLatch(1);
 ExecutorService caller = Executors.newSingleThreadExecutor();
 try {
  caller.submit(() -> s.notifyCreated(() -> { entered.countDown(); try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } })).get(1, TimeUnit.SECONDS);
  if (!entered.await(1, TimeUnit.SECONDS)) throw new AssertionError("not scheduled");
  release.countDown();
  s.notifyCreated(() -> { throw new IllegalStateException("remote failure"); });
  s.notifyCreated(done::countDown);
  if (!done.await(2, TimeUnit.SECONDS)) throw new AssertionError("subsequent delivery lost");
 } finally { release.countDown(); caller.shutdownNow(); s.close(); }
 s.notifyCreated(() -> { throw new AssertionError("executed after close"); });
NotificationService draining = new NotificationService();
 CountDownLatch gate = new CountDownLatch(1), active = new CountDownLatch(1), drained = new CountDownLatch(1);
 ScheduledExecutorService releaseTimer = Executors.newSingleThreadScheduledExecutor();
 try {
  draining.notifyCreated(() -> { active.countDown(); try { gate.await(); drained.countDown(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } });
  if (!active.await(1, TimeUnit.SECONDS)) throw new AssertionError("not active");
  releaseTimer.schedule(gate::countDown, 200, TimeUnit.MILLISECONDS);
  draining.close();
  if (drained.getCount() != 0) throw new AssertionError("close returned before accepted task completed");
 } finally { gate.countDown(); draining.close(); releaseTimer.shutdownNow(); }
 System.out.println("PASS");
} }
