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
 * 任务都更重要，则抛出 {@link RejectedExecutionException}，不淘汰它们。</p>
 */
public class UrgentTaskDispatcher {

    private static final Logger log = LoggerFactory.getLogger(UrgentTaskDispatcher.class);

    private static final int DEFAULT_PRIORITY = 0;

    private final Consumer<String> handler;

    private final AtomicLong sequence = new AtomicLong();

    private final ThreadPoolExecutor dispatcher;

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
                new PriorityBlockingQueue<>(200),
                namedFactory("urgent-task"),
                new StrictAdmissionPolicy());
    }

    public void dispatch(String taskId) {
        dispatch(taskId, DEFAULT_PRIORITY);
    }

    public void dispatch(String taskId, int priority) {
        UrgentTask task = new UrgentTask(taskId, priority, sequence.incrementAndGet());
        dispatcher.execute(task);
    }

    private static java.util.concurrent.ThreadFactory namedFactory(String prefix) {
        AtomicInteger seq = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + seq.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        };
    }

    private final class UrgentTask implements Runnable, Comparable<UrgentTask> {

        private final String taskId;
        private final int priority;
        private final long seq;

        UrgentTask(String taskId, int priority, long seq) {
            this.taskId = taskId;
            this.priority = priority;
            this.seq = seq;
        }

        @Override
        public void run() {
            try {
                handler.accept(taskId);
            } catch (RuntimeException e) {
                log.error("urgent task failed, taskId={}, priority={}", taskId, priority, e);
                throw e;
            }
        }

        @Override
        public int compareTo(UrgentTask other) {
            int cmp = Integer.compare(other.priority, this.priority);
            if (cmp != 0) {
                return cmp;
            }
            return Long.compare(this.seq, other.seq);
        }
    }

    /**
     * 严格准入：队列满时，原子地淘汰“最低优先级中最旧且优先级不高于新任务”的排队任务，
     * 再接收新任务；若所有排队任务都更重要，则拒绝新任务。
     */
    private final class StrictAdmissionPolicy implements java.util.concurrent.RejectedExecutionHandler {

        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
            if (e.isShutdown()) {
                log.warn("dispatcher is shutdown, task rejected");
                throw new RejectedExecutionException("dispatcher is shutdown");
            }
            if (!(r instanceof UrgentTask)) {
                log.warn("non-urgent task rejected");
                throw new RejectedExecutionException("unsupported task type");
            }
            UrgentTask incoming = (UrgentTask) r;
            PriorityBlockingQueue<Runnable> queue = queueOf(e);
            if (queue == null) {
                log.warn("queue is not PriorityBlockingQueue, task rejected, taskId={}", incoming.taskId);
                throw new RejectedExecutionException("queue type unsupported");
            }
            synchronized (queue) {
                UrgentTask victim = findVictim(queue, incoming.priority);
                if (victim == null) {
                    log.warn("no evictable task, reject incoming taskId={}, priority={}",
                            incoming.taskId, incoming.priority);
                    throw new RejectedExecutionException(
                            "all queued tasks are more important than incoming task");
                }
                if (!queue.remove(victim)) {
                    log.warn("eviction race, reject incoming taskId={}", incoming.taskId);
                    throw new RejectedExecutionException("eviction failed");
                }
                log.warn("evicted taskId={}, priority={} to admit taskId={}, priority={}",
                        victim.taskId, victim.priority, incoming.taskId, incoming.priority);
                if (!queue.offer(incoming)) {
                    log.warn("re-offer failed, reject incoming taskId={}", incoming.taskId);
                    throw new RejectedExecutionException("re-offer failed");
                }
            }
        }

        @SuppressWarnings("unchecked")
        private PriorityBlockingQueue<Runnable> queueOf(ThreadPoolExecutor e) {
            java.util.concurrent.BlockingQueue<Runnable> q = e.getQueue();
            if (q instanceof PriorityBlockingQueue) {
                return (PriorityBlockingQueue<Runnable>) q;
            }
            return null;
        }

        private UrgentTask findVictim(PriorityBlockingQueue<Runnable> queue, int incomingPriority) {
            UrgentTask victim = null;
            for (Runnable runnable : queue) {
                if (!(runnable instanceof UrgentTask)) {
                    continue;
                }
                UrgentTask candidate = (UrgentTask) runnable;
                if (candidate.priority > incomingPriority) {
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