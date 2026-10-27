package com.example.realtime.service;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

/** Agent-authored v2 reference: effects are supplied through an explicit callback. */
public class RealtimePushHandler {
    private static final System.Logger LOG = System.getLogger(RealtimePushHandler.class.getName());
    private final Consumer<String> downstream;
    private final Object lifecycle = new Object();
    private boolean closed;
    private final Queue<Runnable> pendingTasks = new ConcurrentLinkedQueue<>();
    private final AtomicLong submitted = new AtomicLong(), completed = new AtomicLong(), failed = new AtomicLong(), rejected = new AtomicLong();
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(2, 2, 30L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(16), namedFactory(), new ThreadPoolExecutor.AbortPolicy());

    public RealtimePushHandler() { this(null, false); }
    public RealtimePushHandler(Consumer<String> downstream) { this(downstream, true); }
    private RealtimePushHandler(Consumer<String> downstream, boolean configured) {
        this.downstream = configured ? Objects.requireNonNull(downstream) : downstream;
    }
    public void onEvent(String input) {
        Objects.requireNonNull(input);
        synchronized(lifecycle) {
            if(closed) { reject(input); throw new RejectedExecutionException("Service stopped"); }
            if(downstream == null) throw new IllegalStateException("Downstream not configured");
            try {
                executor.execute(() -> invoke(input));
                submitted.incrementAndGet();
            } catch(RejectedExecutionException error) { reject(input); throw error; }
        }
    }
    private void invoke(String input) {
        try {
                downstream.accept(input);
            completed.incrementAndGet();
        } catch(RuntimeException error) {
            failed.incrementAndGet(); LOG.log(System.Logger.Level.ERROR, "Business callback failed", error);
        }
    }
    private void reject(String input) {
        rejected.incrementAndGet();
        LOG.log(System.Logger.Level.WARNING, "Rejected business input: " + input);
    }
    public Map<String,Long> stats() { return Map.of("submitted", submitted.get(), "completed", completed.get(), "failed", failed.get(), "rejected", rejected.get()); }
    public void stop() {
        synchronized(lifecycle) { closed = true; executor.shutdown(); }
        try {
            if(!executor.awaitTermination(200, TimeUnit.MILLISECONDS)) {
                List<Runnable> pending = executor.shutdownNow();
                pendingTasks.addAll(pending);
                for(Runnable task:pending) if(task instanceof Future<?> future) future.cancel(false);
                LOG.log(System.Logger.Level.WARNING, "Pending tasks on forced stop: " + pending.size());
                if(!executor.awaitTermination(500, TimeUnit.MILLISECONDS)) throw new IllegalStateException("Business work did not terminate");
            }
        } catch(InterruptedException error) {
            List<Runnable> pending = executor.shutdownNow();
            pendingTasks.addAll(pending);
            for(Runnable task:pending) if(task instanceof Future<?> future) future.cancel(false);
            Thread.currentThread().interrupt(); throw new IllegalStateException("Stop interrupted", error);
        }
    }
    private static ThreadFactory namedFactory() {
        AtomicInteger sequence = new AtomicInteger();
        return task -> new Thread(task, "realtime-push-" + sequence.incrementAndGet());
    }
}
