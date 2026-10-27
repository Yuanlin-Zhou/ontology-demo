public class ContextRunner {
    public static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();

    public static Runnable wrap(String requestId, Runnable task) {
        if (task == null) {
            throw new NullPointerException("task");
        }
        return () -> {
            String previous = CONTEXT.get();
            CONTEXT.set(requestId);
            try {
                task.run();
            } finally {
                if (previous == null) {
                    CONTEXT.remove();
                } else {
                    CONTEXT.set(previous);
                }
            }
        };
    }
}