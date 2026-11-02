package com.example.inventory.service;

import java.util.Collection;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Inventory sync service with a dedicated bounded thread pool and compensation queue. */
public class InventorySyncService {

    private static final Logger LOGGER = LoggerFactory.getLogger(InventorySyncService.class);

    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 2000L;

    private final ThreadPoolExecutor syncExecutor;

    private final Consumer<String> synchronizer;

    private final Collection<String> retryQueue = new ConcurrentLinkedQueue<>();

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    private volatile boolean stopped;

    public InventorySyncService() {
        this(null);
    }

    public InventorySyncService(Consumer<String> synchronizer) {
        this.synchronizer = synchronizer;
        ThreadFactory threadFactory = runnable -> {
            Thread thread = new Thread(runnable, "inventory-sync-worker");
            thread.setDaemon(false);
            return thread;
        };
        this.syncExecutor = new ThreadPoolExecutor(
                4,
                8,
                60L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(100),
                threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void sync(String sku) {
        Objects.requireNonNull(sku, "sku");
        if (stopped) {
            rejected.incrementAndGet();
            retryQueue.add(sku);
            LOGGER.warn("Inventory sync rejected because service is stopped, sku={}", sku);
            throw new RejectedExecutionException("Inventory sync service is stopped");
        }
        Consumer<String> target = this.synchronizer;
        if (target == null) {
            throw new IllegalStateException("Inventory sync synchronizer is not configured");
        }
        try {
            syncExecutor.execute(() -> {
                try {
                    target.accept(sku);
                    completed.incrementAndGet();
                } catch (RuntimeException ex) {
                    failed.incrementAndGet();
                    LOGGER.error("Inventory sync failed for sku={}", sku, ex);
                }
            });
            submitted.incrementAndGet();
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            retryQueue.add(sku);
            LOGGER.warn("Inventory sync rejected due to saturation, sku={}", sku);
            throw ex;
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> snapshot = new ConcurrentHashMap<>();
        snapshot.put("submitted", submitted.get());
        snapshot.put("completed", completed.get());
        snapshot.put("failed", failed.get());
        snapshot.put("rejected", rejected.get());
        return snapshot;
    }

    public void stop() {
        stopped = true;
        syncExecutor.shutdown();
        boolean terminated = false;
        try {
            terminated = syncExecutor.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS);
            if (!terminated) {
                syncExecutor.shutdownNow();
                terminated = syncExecutor.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException ex) {
            syncExecutor.shutdownNow();
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while stopping inventory sync service", ex);
        }
        if (!terminated) {
            throw new IllegalStateException("Inventory sync service did not terminate in time");
        }
    }
}