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
 * 最低优先级中最旧且优先级不高于新任务的排队任务，再接收新任务；若所有排队任务
 * 都更重要则抛出 {@link RejectedExecutionException}。淘汰、拒绝和任务异常均可观测。</p>
 */
public class UrgentTaskDispatcher {

    private static final Logger LOGGER = LoggerFactory.getLogger(UrgentTaskDispatcher.class);

    private static final int QUEUE_CAPACITY = 200;

    private final Consumer<String> handler;

    /** 保留可反射观察的实例字段。 */
    private final ThreadPoolExecutor dispatcher;

    private final AtomicLong sequence = new AtomicLong();

    public UrgentTaskDispatcher() {
        this(taskId -> { });
    }

    public UrgentTaskDispatcher(Consumer<String> handler) {
        this.handler = handler == null ? taskId -> { } : handler;
        // 固定 core=max，避免队列满时扩容非核心线程绕过严格准入控制。
        this.dispatcher = new ThreadPoolExecutor(
                4,
                4,
                60L,
                TimeUnit.SECONDS,
                new PriorityBlockingQueue<>(QUEUE_CAPACITY),
                namedFactory("urgent-task"),
                new StrictAdmissionPolicy());
    }

    public void dispatch(String taskId) {
        dispatch(taskId, 0);
    }

    public void dispatch(String taskId, int priority) {
        PrioritizedTask task = new PrioritizedTask(taskId, priority, sequence.incrementAndGet());
        try {
            dispatcher.execute(task);
        } catch (RejectedExecutionException e) {
            LOGGER.warn("Task rejected: id={}, priority={}", taskId, priority);
            throw e;
        }
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        AtomicInteger seq = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + seq.incrementAndGet());
            return thread;
        };
    }

    private void handle(String taskId) {
        try {
            handler.accept(taskId);
        } catch (RuntimeException e) {
            LOGGER.error("Task handling failed: id={}", taskId, e);
            throw e;
        }
    }

    private final class PrioritizedTask implements Runnable, Comparable<PrioritizedTask> {
        private final String taskId;
        private final int priority;
        private final long seq;

        PrioritizedTask(String taskId, int priority, long seq) {
            this.taskId = taskId;
            this.priority = priority;
            this.seq = seq;
        }

        @Override
        public void run() {
            handle(taskId);
        }

        @Override
        public int compareTo(PrioritizedTask other) {
            int cmp = Integer.compare(other.priority, this.priority);
            if (cmp != 0) {
                return cmp;
            }
            return Long.compare(this.seq, other.seq);
        }
    }

    /**
     * 严格准入策略：队列满时，原子地淘汰最低优先级中最旧且优先级不高于新任务的排队任务；
     * 若不存在这样的任务则拒绝新任务。
     */
    private final class StrictAdmissionPolicy implements java.util.concurrent.RejectedExecutionHandler {
        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            if (!(r instanceof PrioritizedTask newTask)) {
                throw new RejectedExecutionException("Unsupported task type");
            }
            PriorityBlockingQueue<Runnable> queue =
                    (PriorityBlockingQueue<Runnable>) executor.getQueue();
            synchronized (queue) {
                if (queue.size() < QUEUE_CAPACITY) {
                    if (executor.isShutdown()) {
                        throw new RejectedExecutionException("Executor is shutdown");
                    }
                    queue.offer(r);
                    return;
                }
                PrioritizedTask victim = findVictim(queue, newTask);
                if (victim == null) {
                    throw new RejectedExecutionException(
                            "All queued tasks are more important than the new task");
                }
                queue.remove(victim);
                LOGGER.warn("Evicted task: id={}, priority={} for new task id={}, priority={}",
                        victim.taskId, victim.priority, newTask.taskId, newTask.priority);
                if (executor.isShutdown()) {
                    throw new RejectedExecutionException("Executor is shutdown");
                }
                queue.offer(r);
            }
        }

        private PrioritizedTask findVictim(PriorityBlockingQueue<Runnable> queue, PrioritizedTask newTask) {
            PrioritizedTask victim = null;
            for (Runnable runnable : queue) {
                if (!(runnable instanceof PrioritizedTask candidate)) {
                    continue;
                }
                if (candidate.priority > newTask.priority) {
                    continue;
                }
                if (victim == null
                        || candidate.priority < victim.priority
                        || (candidate.priority == victim.priority && candidate.seq < victim.seq)) {
                    victim = candidate;
                }
            }
            return victim;
        }
    }
}