package com.example.urgent.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * 紧急任务优先队列调度器。
 *
 * <p>有界优先级阻塞队列：按优先级降序、同级提交序号升序取任务。
 * 队列满时原子地淘汰“最低优先级中最旧且优先级不高于新任务”的排队任务；
 * 若所有排队任务都更重要，则抛出 {@link RejectedExecutionException}。
 * 淘汰、拒绝与任务异常均可观测。</p>
 */
public class UrgentTaskDispatcher {

    private static final Logger LOGGER = Logger.getLogger(UrgentTaskDispatcher.class.getName());

    private static final int QUEUE_CAPACITY = 200;
    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;

    private final Consumer<String> handler;

    private final AtomicLong rejectedCount = new AtomicLong();
    private final AtomicLong evictedCount = new AtomicLong();
    private final AtomicLong failedCount = new AtomicLong();

    private final ThreadPoolExecutor dispatcher;

    public UrgentTaskDispatcher() {
        this(taskId -> { });
    }

    public UrgentTaskDispatcher(Consumer<String> handler) {
        this.handler = Objects.requireNonNull(handler, "handler");
        BoundedPriorityQueue queue = new BoundedPriorityQueue(QUEUE_CAPACITY);
        // 固定 core=max，避免队列满时扩容非核心线程绕过严格准入控制。
        this.dispatcher = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                queue,
                namedFactory("urgent-task"),
                (r, executor) -> {
                    // 队列已通过自定义 offer 完成淘汰/拒绝决策；此处仅兜底。
                    rejectedCount.incrementAndGet();
                    LOGGER.log(Level.WARNING, "Task rejected by executor");
                    throw new RejectedExecutionException("Task rejected: queue full and no evictable task");
                });
        this.dispatcher.allowCoreThreadTimeOut(false);
    }

    public void dispatch(String taskId) {
        dispatch(taskId, 0);
    }

    public void dispatch(String taskId, int priority) {
        Objects.requireNonNull(taskId, "taskId");
        PrioritizedTask task = new PrioritizedTask(taskId, priority);
        try {
            dispatcher.execute(task);
        } catch (RejectedExecutionException e) {
            rejectedCount.incrementAndGet();
            LOGGER.log(Level.WARNING, "Rejected task " + taskId + " priority=" + priority);
            throw e;
        }
    }

    public long getRejectedCount() {
        return rejectedCount.get();
    }

    public long getEvictedCount() {
        return evictedCount.get();
    }

    public long getFailedCount() {
        return failedCount.get();
    }

    public int getQueueSize() {
        return dispatcher.getQueue().size();
    }

    public int getActiveCount() {
        return dispatcher.getActiveCount();
    }

    public long getCompletedTaskCount() {
        return dispatcher.getCompletedTaskCount();
    }

    public long getTaskCount() {
        return dispatcher.getTaskCount();
    }

    public void shutdown() {
        dispatcher.shutdown();
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private final class PrioritizedTask implements Runnable {
        final String taskId;
        final int priority;
        final long sequence;

        PrioritizedTask(String taskId, int priority) {
            this.taskId = taskId;
            this.priority = priority;
            this.sequence = SEQUENCE.incrementAndGet();
        }

        @Override
        public void run() {
            try {
                handler.accept(taskId);
            } catch (RuntimeException e) {
                failedCount.incrementAndGet();
                LOGGER.log(Level.SEVERE, "Task failed: " + taskId, e);
                throw e;
            }
        }
    }

    private static final AtomicLong SEQUENCE = new AtomicLong();

    /**
     * 有界优先级阻塞队列。offer 的容量检查、淘汰选择与插入在同一把锁内原子完成。
     */
    private final class BoundedPriorityQueue implements BlockingQueue<Runnable> {

        private final int capacity;
        private final ReentrantLock lock = new ReentrantLock();
        private final Condition notEmpty = lock.newCondition();
        private final List<PrioritizedTask> items;

        BoundedPriorityQueue(int capacity) {
            this.capacity = capacity;
            this.items = new ArrayList<>(capacity);
        }

        private static final Comparator<PrioritizedTask> ORDER =
                Comparator.comparingInt((PrioritizedTask t) -> t.priority).reversed()
                        .thenComparingLong(t -> t.sequence);

        @Override
        public boolean offer(Runnable r) {
            if (!(r instanceof PrioritizedTask)) {
                throw new IllegalArgumentException("Only PrioritizedTask supported");
            }
            PrioritizedTask task = (PrioritizedTask) r;
            lock.lock();
            try {
                if (items.size() < capacity) {
                    insertSorted(task);
                    notEmpty.signal();
                    return true;
                }
                // 队列满：寻找最低优先级中最旧且优先级不高于新任务的候选。
                PrioritizedTask victim = null;
                for (PrioritizedTask candidate : items) {
                    if (candidate.priority > task.priority) {
                        continue;
                    }
                    if (victim == null
                            || candidate.priority < victim.priority
                            || (candidate.priority == victim.priority
                                    && candidate.sequence < victim.sequence)) {
                        victim = candidate;
                    }
                }
                if (victim == null) {
                    return false;
                }
                items.remove(victim);
                evictedCount.incrementAndGet();
                LOGGER.log(Level.INFO, "Evicted task " + victim.taskId
                        + " priority=" + victim.priority + " for new task " + task.taskId
                        + " priority=" + task.priority);
                insertSorted(task);
                notEmpty.signal();
                return true;
            } finally {
                lock.unlock();
            }
        }

        private void insertSorted(PrioritizedTask task) {
            int idx = 0;
            while (idx < items.size() && ORDER.compare(items.get(idx), task) <= 0) {
                idx++;
            }
            items.add(idx, task);
        }

        @Override
        public void put(Runnable r) {
            if (!offer(r)) {
                throw new RejectedExecutionException("Queue full");
            }
        }

        @Override
        public boolean offer(Runnable r, long timeout, TimeUnit unit) {
            return offer(r);
        }

        @Override
        public Runnable take() throws InterruptedException {
            lock.lockInterruptibly();
            try {
                while (items.isEmpty()) {
                    notEmpty.await();
                }
                return items.remove(0);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public Runnable poll(long timeout, TimeUnit unit) throws InterruptedException {
            long nanos = unit.toNanos(timeout);
            lock.lockInterruptibly();
            try {
                while (items.isEmpty()) {
                    if (nanos <= 0L) {
                        return null;
                    }
                    nanos = notEmpty.awaitNanos(nanos);
                }
                return items.remove(0);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public Runnable poll() {
            lock.lock();
            try {
                return items.isEmpty() ? null : items.remove(0);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public int size() {
            lock.lock();
            try {
                return items.size();
            } finally {
                lock.unlock();
            }
        }

        @Override
        public int remainingCapacity() {
            lock.lock();
            try {
                return capacity - items.size();
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean remove(Object o) {
            lock.lock();
            try {
                return items.remove(o);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean contains(Object o) {
            lock.lock();
            try {
                return items.contains(o);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public int drainTo(java.util.Collection<? super Runnable> c) {
            return drainTo(c, Integer.MAX_VALUE);
        }

        @Override
        public int drainTo(java.util.Collection<? super Runnable> c, int maxElements) {
            Objects.requireNonNull(c, "c");
            if (maxElements <= 0) {
                return 0;
            }
            lock.lock();
            try {
                int n = Math.min(maxElements, items.size());
                for (int i = 0; i < n; i++) {
                    c.add(items.remove(0));
                }
                return n;
            } finally {
                lock.unlock();
            }
        }

        @Override
        public java.util.Iterator<Runnable> iterator() {
            lock.lock();
            try {
                List<Runnable> snapshot = new ArrayList<>(items);
                return snapshot.iterator();
            } finally {
                lock.unlock();
            }
        }

        @Override
        public Object[] toArray() {
            lock.lock();
            try {
                return items.toArray();
            } finally {
                lock.unlock();
            }
        }

        @Override
        public <T> T[] toArray(T[] a) {
            lock.lock();
            try {
                return items.toArray(a);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean add(Runnable r) {
            if (offer(r)) {
                return true;
            }
            throw new IllegalStateException("Queue full");
        }

        @Override
        public boolean addAll(java.util.Collection<? extends Runnable> c) {
            boolean changed = false;
            for (Runnable r : c) {
                changed |= add(r);
            }
            return changed;
        }

        @Override
        public boolean containsAll(java.util.Collection<?> c) {
            lock.lock();
            try {
                return items.containsAll(c);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean removeAll(java.util.Collection<?> c) {
            lock.lock();
            try {
                return items.removeAll(c);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean retainAll(java.util.Collection<?> c) {
            lock.lock();
            try {
                return items.retainAll(c);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public void clear() {
            lock.lock();
            try {
                items.clear();
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean isEmpty() {
            lock.lock();
            try {
                return items.isEmpty();
            } finally {
                lock.unlock();
            }
        }
    }
}