import java.util.concurrent.*;
public class Harness { public static void main(String[] args) throws Exception {
ContextRunner.CONTEXT.set("caller");
 Runnable task = ContextRunner.wrap("request", () -> { if (!"request".equals(ContextRunner.CONTEXT.get())) throw new AssertionError("missing request"); });
 if (!"caller".equals(ContextRunner.CONTEXT.get())) throw new AssertionError("caller changed");
 ExecutorService pool = Executors.newSingleThreadExecutor();
 try {
  pool.submit(() -> { task.run(); if (ContextRunner.CONTEXT.get() != null) throw new AssertionError("leak"); }).get(1, TimeUnit.SECONDS);
  pool.submit(() -> { ContextRunner.CONTEXT.set("previous"); try { ContextRunner.wrap("next", () -> { throw new IllegalStateException("expected"); }).run(); throw new AssertionError("exception swallowed"); } catch (IllegalStateException expected) { } if (!"previous".equals(ContextRunner.CONTEXT.get())) throw new AssertionError("previous lost"); ContextRunner.CONTEXT.remove(); }).get(1, TimeUnit.SECONDS);
 } finally { pool.shutdownNow(); ContextRunner.CONTEXT.remove(); }
System.out.println("PASS");
} }
