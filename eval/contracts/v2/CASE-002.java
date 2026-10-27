package com.example.order.service;
import com.example.order.domain.Order;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

/** Agent-authored v2 reference: effects are supplied through an explicit callback. */
public class OrderSyncService {
    private static final System.Logger LOG = System.getLogger(OrderSyncService.class.getName());
    private final Consumer<Order> downstream;
    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();
    private final java.util.function.Function<String,Order> loader;
    private final Object lifecycle = new Object();
    private boolean closed;
    private final Queue<Runnable> pendingTasks = new ConcurrentLinkedQueue<>();
    private final AtomicLong submitted = new AtomicLong(), completed = new AtomicLong(), failed = new AtomicLong(), rejected = new AtomicLong();
    private final ThreadPoolExecutor syncExecutor = new ThreadPoolExecutor(2, 2, 30L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(16), namedFactory(), new ThreadPoolExecutor.AbortPolicy());

    public OrderSyncService() { this(null, null, false); }
    public OrderSyncService(Consumer<Order> downstream, java.util.function.Function<String,Order> loader) { this(downstream, loader, true); }
    private OrderSyncService(Consumer<Order> downstream, java.util.function.Function<String,Order> loader, boolean configured) {
        this.downstream = configured ? Objects.requireNonNull(downstream) : downstream;
        this.loader = configured ? Objects.requireNonNull(loader) : loader;
    }
    public void syncCreated(Order input) {
        Objects.requireNonNull(input);
        synchronized(lifecycle) {
            if(closed) { reject(input); throw new RejectedExecutionException("Service stopped"); }
            if(downstream == null) throw new IllegalStateException("Downstream not configured");
            try {
                syncExecutor.execute(() -> invoke(input));
                submitted.incrementAndGet();
            } catch(RejectedExecutionException error) { reject(input); throw error; }
        }
    }
    private void invoke(Order input) {
        try {
                String previous = TENANT.get();
                try { TENANT.set(input.tenantId()); downstream.accept(input); }
                finally { if(previous == null) TENANT.remove(); else TENANT.set(previous); }
            completed.incrementAndGet();
        } catch(RuntimeException error) {
            failed.incrementAndGet(); LOG.log(System.Logger.Level.ERROR, "Business callback failed", error);
        }
    }
    private void reject(Order input) {
        rejected.incrementAndGet();
        LOG.log(System.Logger.Level.WARNING, "Rejected business input: " + input);
    }
    public Map<String,Long> stats() { return Map.of("submitted", submitted.get(), "completed", completed.get(), "failed", failed.get(), "rejected", rejected.get()); }
    public void stop() {
        synchronized(lifecycle) { closed = true; syncExecutor.shutdown(); }
        try {
            if(!syncExecutor.awaitTermination(200, TimeUnit.MILLISECONDS)) {
                List<Runnable> pending = syncExecutor.shutdownNow();
                pendingTasks.addAll(pending);
                for(Runnable task:pending) if(task instanceof Future<?> future) future.cancel(false);
                LOG.log(System.Logger.Level.WARNING, "Pending tasks on forced stop: " + pending.size());
                if(!syncExecutor.awaitTermination(500, TimeUnit.MILLISECONDS)) throw new IllegalStateException("Business work did not terminate");
            }
        } catch(InterruptedException error) {
            List<Runnable> pending = syncExecutor.shutdownNow();
            pendingTasks.addAll(pending);
            for(Runnable task:pending) if(task instanceof Future<?> future) future.cancel(false);
            Thread.currentThread().interrupt(); throw new IllegalStateException("Stop interrupted", error);
        }
    }

    public Order reload(String id) throws Exception {
        Future<Order> future;
        synchronized(lifecycle) {
            if(closed) throw new RejectedExecutionException("Service stopped");
            if(loader == null) throw new IllegalStateException("Loader not configured");
            future = syncExecutor.submit(() -> loader.apply(id));
        }
        try { return future.get(1, TimeUnit.SECONDS); }
        catch(TimeoutException error) { future.cancel(true); syncExecutor.remove((Runnable)future); throw error; }
        catch(InterruptedException error) { future.cancel(true); syncExecutor.remove((Runnable)future); Thread.currentThread().interrupt(); throw error; }
    }
    private static ThreadFactory namedFactory() {
        AtomicInteger sequence = new AtomicInteger();
        return task -> new Thread(task, "order-sync-" + sequence.incrementAndGet());
    }
}
