package com.example.urgent.service;

import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 紧急任务优先队列调度器。
 *
 * <p>优先级数值越大越优先；同级按提交顺序 FIFO。队列有界，满载时原子地淘汰
 * “最低优先级中最旧且优先级不高于新任务”的排队任务，再接收新任务；若所有排队
 * 任务都更重要则抛出 {@link RejectedExecutionException}。淘汰、拒绝和任务异常
 * 均可观测。</p>
 */
public class UrgentTaskDispatcher {

    private static final Logger logger = LoggerFactory.getLogger(UrgentTaskDispatcher.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 200;

    /** 可反射观察的执行器实例字段。 */
    private final ThreadPoolExecutor dispatcher;

    private final Consumer<String> handler;

    private final AtomicLong sequence = new AtomicLong();

    public UrgentTaskDispatcher() {
        this(taskId -> { });
    }

    public UrgentTaskDispatcher(Consumer<String> handler) {
        if (handler == null) {
            throw new IllegalArgumentException("handler must not be null");
        }
        this.handler = handler;
        // 固定 core=max，避免队列满时扩容非核心线程绕过严格准入控制。
        this.dispatcher = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                CORE_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new PriorityBlockingQueue<>(QUEUE_CAPACITY),
                namedFactory("urgent-task"),
                new StrictAdmissionPolicy());
    }

    public void dispatch(String taskId) {
        dispatch(taskId, 0);
    }

    public void dispatch(String taskId, int priority) {
        if (taskId == null) {
            throw new IllegalArgumentException("taskId must not be null");
        }
        PrioritizedTask task = new PrioritizedTask(taskId, priority, sequence.incrementAndGet());
        dispatcher.execute(task);
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        AtomicInteger seq = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable);
            thread.setName(prefix + "-" + seq.incrementAndGet());
            return thread;
        };
    }

    private final class PrioritizedTask implements Runnable, Comparable<PrioritizedTask> {

        private final String taskId;
        private final int priority;
        private final long order;

        PrioritizedTask(String taskId, int priority, long order) {
            this.taskId = taskId;
            this.priority = priority;
            this.order = order;
        }

        String taskId() {
            return taskId;
        }

        int priority() {
            return priority;
        }

        long order() {
            return order;
        }

        @Override
        public int compareTo(PrioritizedTask other) {
            int byPriority = Integer.compare(other.priority, this.priority);
            if (byPriority != 0) {
                return byPriority;
            }
            return Long.compare(this.order, other.order);
        }

        @Override
        public void run() {
            try {
                handler.accept(taskId);
            } catch (RuntimeException ex) {
                logger.error("Task execution failed, taskId={}, priority={}", taskId, priority, ex);
                throw ex;
            }
        }
    }

    /**
     * 严格准入策略：队列满时，原子地淘汰最低优先级中最旧且优先级不高于新任务的
     * 排队任务；若不存在这样的任务则拒绝新任务。
     */
    private final class StrictAdmissionPolicy implements java.util.concurrent.RejectedExecutionHandler {

        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            if (!(r instanceof PrioritizedTask newTask)) {
                throw new RejectedExecutionException("Unsupported task type: " + r);
            }
            if (executor.isShutdown()) {
                logger.warn("Rejected task because executor is shutdown, taskId={}", newTask.taskId());
                throw new RejectedExecutionException("Executor is shutdown");
            }
            PriorityBlockingQueue<Runnable> queue = queueOf(executor);
            if (queue == null) {
                logger.warn("Rejected task because queue is unavailable, taskId={}", newTask.taskId());
                throw new RejectedExecutionException("Queue unavailable");
            }
            synchronized (queue) {
                PrioritizedTask victim = findVictim(queue, newTask);
                if (victim == null) {
                    logger.warn("Rejected task because all queued tasks are more important, taskId={}, priority={}",
                            newTask.taskId(), newTask.priority());
                    throw new RejectedExecutionException(
                            "All queued tasks are more important than task " + newTask.taskId());
                }
                boolean removed = queue.remove(victim);
                if (!removed) {
                    logger.warn("Rejected task because victim disappeared, taskId={}", newTask.taskId());
                    throw new RejectedExecutionException("Failed to evict queued task");
                }
                logger.warn("Evicted queued task, victimId={}, victimPriority={}, newId={}, newPriority={}",
                        victim.taskId(), victim.priority(), newTask.taskId(), newTask.priority());
                if (!queue.offer(newTask)) {
                    logger.warn("Rejected task after eviction because queue is full, taskId={}", newTask.taskId());
                    throw new RejectedExecutionException("Queue full after eviction");
                }
            }
        }

        @SuppressWarnings("unchecked")
        private PriorityBlockingQueue<Runnable> queueOf(ThreadPoolExecutor executor) {
            if (executor.getQueue() instanceof PriorityBlockingQueue<?> q) {
                return (PriorityBlockingQueue<Runnable>) q;
            }
            return null;
        }

        private PrioritizedTask findVictim(PriorityBlockingQueue<Runnable> queue, PrioritizedTask newTask) {
            PrioritizedTask victim = null;
            for (Runnable runnable : queue) {
                if (!(runnable instanceof PrioritizedTask candidate)) {
                    continue;
                }
                if (candidate.priority() > newTask.priority()) {
                    continue;
                }
                if (victim == null
                        || candidate.priority() < victim.priority()
                        || (candidate.priority() == victim.priority() && candidate.order() < victim.order())) {
                    victim = candidate;
                }
            }
            return victim;
        }
    }
}