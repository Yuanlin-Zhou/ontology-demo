public class ContextRunner {
 public static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();
 public static Runnable wrap(String requestId, Runnable task) {
  return () -> { CONTEXT.set(requestId); task.run(); };
 }
}
