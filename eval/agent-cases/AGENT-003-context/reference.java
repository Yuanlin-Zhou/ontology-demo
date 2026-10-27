public class ContextRunner {
 public static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();
 public static Runnable wrap(String requestId, Runnable task) {
  return () -> { String old = CONTEXT.get(); try { CONTEXT.set(requestId); task.run(); } finally { if (old == null) CONTEXT.remove(); else CONTEXT.set(old); } };
 }
}
