package com.example.loom.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/** Admission happens before launching virtual threads, bounding downstream calls and waiting work. */
public class LoomNotifier {
    private static final Logger LOG = Logger.getLogger(LoomNotifier.class.getName());
    private final Semaphore downstreamLimit;
    private final Consumer<String> downstream;
    private final Object lifecycle = new Object();
    private final AtomicLong completed = new AtomicLong(), failed = new AtomicLong(), rejected = new AtomicLong();
    private int inFlight;
    private boolean closed;

    public LoomNotifier() { this(200, id -> LOG.info("Notify downstream for " + id)); }
    public LoomNotifier(int maxConcurrent, Consumer<String> downstream) {
        if (maxConcurrent < 1) throw new IllegalArgumentException("maxConcurrent must be positive");
        this.downstreamLimit = new Semaphore(maxConcurrent);
        this.downstream = Objects.requireNonNull(downstream);
    }
    public void notify(String orderId) {
        Objects.requireNonNull(orderId);
        synchronized (lifecycle) {
            if (closed || !downstreamLimit.tryAcquire()) {
                rejected.incrementAndGet();
                LOG.warning("Notification rejected: " + orderId);
                throw new RejectedExecutionException("Notifier closed or downstream saturated");
            }
            inFlight++;
            try {
                Thread.startVirtualThread(() -> {
                    try { downstream.accept(orderId); completed.incrementAndGet(); }
                    catch (RuntimeException error) {
                        failed.incrementAndGet();
                        LOG.log(Level.SEVERE, "Downstream notification failed: " + orderId, error);
                    } finally {
                        downstreamLimit.release();
                        synchronized (lifecycle) { inFlight--; lifecycle.notifyAll(); }
                    }
                });
            } catch (RuntimeException | Error failure) {
                // A launch failure owns the permit until a worker has been created.
                downstreamLimit.release(); inFlight--; lifecycle.notifyAll();
                rejected.incrementAndGet();
                LOG.log(Level.SEVERE, "Cannot start notification: " + orderId, failure);
                throw failure;
            }
        }
    }
    public Map<String, Long> stats() {
        synchronized (lifecycle) {
            return Map.of("active", (long)inFlight, "completed", completed.get(), "failed", failed.get(), "rejected", rejected.get());
        }
    }
    /** Stop admission and drain accepted work; report timeout rather than claiming successful closure. */
    public void stop() {
        synchronized (lifecycle) {
            closed = true;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (inFlight > 0) {
                long left = deadline - System.nanoTime();
                if (left <= 0) throw new IllegalStateException("Downstream notifications still running");
                try { TimeUnit.NANOSECONDS.timedWait(lifecycle, left); }
                catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted while draining notifications", error);
                }
            }
        }
    }
}
