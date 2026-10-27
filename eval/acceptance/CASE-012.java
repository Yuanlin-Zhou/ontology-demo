import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

/** Tests public quotation behavior, including distinct inputs and bounded completion. */
class AcceptanceTest {
    public static void main(String[] args) throws Exception {
        Class<?> target = Class.forName(args[0]);
        Object service = target.getConstructor().newInstance();
        try {
            var quote = target.getMethod("quote", String.class);
            for (String id : new String[]{"order-1", "order-2", ""}) {
                Object output = quote.invoke(service, id);
                if (!(output instanceof CompletableFuture<?> future)) throw new AssertionError("Expected CompletableFuture");
                if (!("quote-" + id).equals(future.get(3, TimeUnit.SECONDS))) throw new AssertionError("Wrong quotation for " + id);
            }
            ThreadPoolExecutor pool = null;
            for (var field : target.getDeclaredFields()) {
                if (ExecutorService.class.isAssignableFrom(field.getType())) {
                    field.setAccessible(true);
                    Object value = field.get(service);
                    if (value instanceof ThreadPoolExecutor candidate) { pool = candidate; break; }
                }
            }
            if (pool == null) { System.out.println("UNAVAILABLE_ADAPTER: No observable ThreadPoolExecutor for saturation testing"); System.exit(77); return; }
            int workers = pool.getCorePoolSize();
            if (workers < 1 || workers > 32) { System.out.println("UNAVAILABLE_ADAPTER: Unsupported business worker count"); System.exit(77); return; }
            CountDownLatch started = new CountDownLatch(workers);
            CountDownLatch release = new CountDownLatch(1);
            try {
                for (int i = 0; i < workers; i++) pool.execute(() -> {
                    started.countDown();
                    try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                });
                if (!started.await(3, TimeUnit.SECONDS)) throw new AssertionError("Could not occupy business workers");
                CompletableFuture<Object> invocation = new CompletableFuture<>();
                Thread caller = new Thread(() -> {
                    try { invocation.complete(quote.invoke(service, "blocked-order")); }
                    catch (Throwable e) { invocation.completeExceptionally(e); }
                }, "test-caller");
                caller.setDaemon(true);
                caller.start();
                Object output;
                try { output = invocation.get(1, TimeUnit.SECONDS); }
                catch (TimeoutException e) { throw new AssertionError("quote blocked its caller instead of returning asynchronously", e); }
                if (!(output instanceof CompletableFuture<?> future)) throw new AssertionError("Expected CompletableFuture");
                if (future.isDone()) throw new AssertionError("quote waited for completion instead of returning an in-flight future");
                try {
                    future.get(6, TimeUnit.SECONDS);
                    throw new AssertionError("Quote did not use the occupied business executor");
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    while (cause instanceof CompletionException && cause.getCause() != null) cause = cause.getCause();
                    if (!(cause instanceof TimeoutException)) throw new AssertionError("Expected application timeout", cause);
                } catch (TimeoutException e) { throw new AssertionError("No effective application timeout", e); }
            } finally { release.countDown(); }
        } finally {
            // Harness cleanup does not count as proof that application lifecycle management works.
            for (var field : target.getDeclaredFields()) {
                if (ExecutorService.class.isAssignableFrom(field.getType())) {
                    field.setAccessible(true);
                    Object value = field.get(service);
                    if (value instanceof ExecutorService executor) executor.shutdownNow();
                }
            }
        }
    }
}
