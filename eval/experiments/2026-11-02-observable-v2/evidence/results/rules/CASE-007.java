package com.example.log.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 日志异步写入线程池。
 *
 * <p>过载时不能静默丢日志：使用有界队列 + AbortPolicy，饱和/关闭时同步抛出
 * {@link RejectedExecutionException} 并计数、告警，由调用侧感知。</p>
 */
public class AsyncLogWriter {

    private static final Logger LOG = LoggerFactory.getLogger(AsyncLogWriter.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 8;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 1000;
    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 1000L;

    private final Consumer<String> sink;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    private final ThreadPoolExecutor writer;

    /** 无参构造：未配置下游，业务入口同步抛 IllegalStateException。 */
    public AsyncLogWriter() {
        this.sink = null;
        this.writer = newWriter();
    }

    /** 配置下游 sink 的构造器。 */
    public AsyncLogWriter(Consumer<String> sink) {
        this.sink = Objects.requireNonNull(sink, "sink");
        this.writer = newWriter();
    }

    private ThreadPoolExecutor newWriter() {
        return new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                namedFactory("async-log"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void write(String message) {
        if (sink == null) {
            throw new IllegalStateException("AsyncLogWriter sink is not configured");
        }
        try {
            writer.execute(() -> runTask(message));
        } catch (RejectedExecutionException e) {
            rejected.incrementAndGet();
            LOG.warn("async-log rejected: queue saturated or executor shut down, message dropped from async path", e);
            throw e;
        }
        submitted.incrementAndGet();
    }

    private void runTask(String message) {
        try {
            sink.accept(message);
            completed.incrementAndGet();
        } catch (RuntimeException e) {
            failed.incrementAndGet();
            LOG.error("async-log sink failed for message", e);
        }
    }

    /** 停止准入，等待已接受任务完成；超时后强制关闭并再次有界等待。 */
    public void stop() {
        writer.shutdown();
        boolean interrupted = false;
        try {
            if (!writer.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                writer.shutdownNow();
                if (!writer.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("async-log executor did not terminate in time");
                }
            }
        } catch (InterruptedException e) {
            interrupted = true;
            writer.shutdownNow();
            try {
                writer.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** 运行及拒绝统计。 */
    public Map<String, Long> stats() {
        Map<String, Long> stats = new ConcurrentHashMap<>();
        stats.put("submitted", submitted.get());
        stats.put("completed", completed.get());
        stats.put("failed", failed.get());
        stats.put("rejected", rejected.get());
        return stats;
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }
}