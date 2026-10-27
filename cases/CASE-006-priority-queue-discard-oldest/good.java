package com.example.urgent.service;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;
import java.util.logging.*;

/** Bounded priority dispatch; only waiting tasks participate in priority/eviction ordering. */
public class UrgentTaskDispatcher {
    private static final Logger LOG = Logger.getLogger(UrgentTaskDispatcher.class.getName());
    private final Consumer<String> handler;
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong(), evicted = new AtomicLong();
    private final Object lifecycle = new Object();
    private final BoundedPriorityQueue queue = new BoundedPriorityQueue(200);
    // Equal core/max prevents a full queue from bypassing priority order through new workers.
    private final ThreadPoolExecutor dispatcher = new ThreadPoolExecutor(
            4, 4, 60L, TimeUnit.SECONDS, queue, namedFactory("urgent-task"), this::reject);

    public UrgentTaskDispatcher() { this(id -> LOG.info("Handling urgent task " + id)); }
    public UrgentTaskDispatcher(Consumer<String> handler) {
        this.handler = Objects.requireNonNull(handler);
        dispatcher.prestartAllCoreThreads();
    }
    public void dispatch(String taskId) { dispatch(taskId, 0); }
    public void dispatch(String taskId, int priority) {
        Objects.requireNonNull(taskId);
        synchronized (lifecycle) {
            try { dispatcher.execute(new Task(taskId, priority, sequence.incrementAndGet())); }
            catch (RejectedExecutionException error) {
                rejected.incrementAndGet();
                LOG.log(Level.WARNING, "Task rejected: " + taskId, error);
                throw error;
            }
        }
    }
    private void reject(Runnable runnable, ThreadPoolExecutor executor) {
        if (executor.isShutdown() || !(runnable instanceof Task task))
            throw new RejectedExecutionException("Dispatcher closed or unsupported task");
        Task victim = queue.replaceLowest(task);
        if (victim != null) {
            evicted.incrementAndGet();
            LOG.warning("Evicted queued task: " + victim.id);
        }
    }
    private final class Task implements Runnable {
        final String id; final int priority; final long order;
        Task(String id, int priority, long order) { this.id=id; this.priority=priority; this.order=order; }
        public void run() {
            try { handler.accept(id); }
            catch (RuntimeException error) { LOG.log(Level.SEVERE, "Task failed: " + id, error); }
        }
    }
    /** All queue operations and replacement use this monitor, including worker removal. */
    private final class BoundedPriorityQueue extends AbstractQueue<Runnable> implements BlockingQueue<Runnable> {
        final int capacity;
        final PriorityQueue<Runnable> items = new PriorityQueue<>((a,b) -> {
            Task left=(Task)a, right=(Task)b;
            int priority = Integer.compare(right.priority, left.priority);
            return priority != 0 ? priority : Long.compare(left.order, right.order);
        });
        BoundedPriorityQueue(int capacity) { this.capacity=capacity; }
        public synchronized boolean offer(Runnable task) {
            Objects.requireNonNull(task);
            if (items.size() == capacity) return false;
            items.add(task); notifyAll(); return true;
        }
        synchronized Task replaceLowest(Task task) {
            if (items.size() < capacity) { offer(task); return null; }
            Task victim=null;
            for (Runnable runnable : items) {
                Task candidate=(Task)runnable;
                if (victim == null || candidate.priority < victim.priority ||
                        (candidate.priority == victim.priority && candidate.order < victim.order)) victim=candidate;
            }
            if (victim == null || victim.priority > task.priority)
                throw new RejectedExecutionException("All queued tasks have higher priority");
            items.remove(victim); items.add(task); notifyAll(); return victim;
        }
        public synchronized Runnable poll() { Runnable r=items.poll(); if(r!=null) notifyAll(); return r; }
        public synchronized Runnable peek() { return items.peek(); }
        public synchronized int size() { return items.size(); }
        public synchronized int remainingCapacity() { return capacity-items.size(); }
        public synchronized Iterator<Runnable> iterator() { return List.copyOf(items).iterator(); }
        public synchronized boolean remove(Object task) { boolean removed=items.remove(task); if(removed) notifyAll(); return removed; }
        public synchronized boolean contains(Object task) { return items.contains(task); }
        public synchronized void clear() { items.clear(); notifyAll(); }
        public synchronized void put(Runnable task) throws InterruptedException {
            Objects.requireNonNull(task);
            if (Thread.interrupted()) throw new InterruptedException();
            while (items.size() == capacity) wait();
            offer(task);
        }
        public synchronized Runnable take() throws InterruptedException {
            if (Thread.interrupted()) throw new InterruptedException();
            while (items.isEmpty()) wait();
            return poll();
        }
        public synchronized boolean offer(Runnable task, long timeout, TimeUnit unit) throws InterruptedException {
            Objects.requireNonNull(task);
            if (Thread.interrupted()) throw new InterruptedException();
            long remaining=unit.toNanos(timeout), end=System.nanoTime()+remaining;
            while (items.size() == capacity) {
                if(remaining<=0) return false;
                TimeUnit.NANOSECONDS.timedWait(this,remaining); remaining=end-System.nanoTime();
            }
            return offer(task);
        }
        public synchronized Runnable poll(long timeout, TimeUnit unit) throws InterruptedException {
            if (Thread.interrupted()) throw new InterruptedException();
            long remaining=unit.toNanos(timeout), end=System.nanoTime()+remaining;
            while (items.isEmpty()) {
                if(remaining<=0) return null;
                TimeUnit.NANOSECONDS.timedWait(this,remaining); remaining=end-System.nanoTime();
            }
            return poll();
        }
        public int drainTo(Collection<? super Runnable> target) { return drainTo(target,Integer.MAX_VALUE); }
        public synchronized int drainTo(Collection<? super Runnable> target, int max) {
            Objects.requireNonNull(target);
            if (target == this) throw new IllegalArgumentException("Cannot drain to self");
            int count=0;
            while(count<max && !items.isEmpty()) { target.add(items.peek()); poll(); count++; }
            return count;
        }
    }
    public String stats() {
        return "active=" + dispatcher.getActiveCount() + ", queued=" + dispatcher.getQueue().size() +
                ", rejected=" + rejected.get() + ", evicted=" + evicted.get();
    }
    public void stop() {
        synchronized(lifecycle) { dispatcher.shutdown(); }
        try {
            if (!dispatcher.awaitTermination(30,TimeUnit.SECONDS)) {
                List<Runnable> pending=dispatcher.shutdownNow();
                LOG.warning("Shutdown pending tasks: " + pending);
            }
        } catch (InterruptedException error) {
            List<Runnable> pending=dispatcher.shutdownNow();
            LOG.warning("Interrupted shutdown pending tasks: " + pending);
            Thread.currentThread().interrupt();
        }
    }
    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger next=new AtomicInteger();
        return task -> {
            Thread thread=new Thread(task,prefix+"-"+next.incrementAndGet());
            thread.setUncaughtExceptionHandler((t,error)->LOG.log(Level.SEVERE,"Worker failed: "+t.getName(),error));
            return thread;
        };
    }
}
