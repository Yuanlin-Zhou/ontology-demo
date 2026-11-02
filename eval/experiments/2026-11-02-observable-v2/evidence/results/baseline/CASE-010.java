package com.example.file.service;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** before.java: 自定义 ThreadFactory 没有给线程命名。 */
public class FileProcessService {

    private static final Logger LOGGER = LoggerFactory.getLogger(FileProcessService.class);

    private static final String THREAD_NAME_PREFIX = "file-process-";

    private final ThreadPoolExecutor processor;

    private final Consumer<String> handler;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    public FileProcessService() {
        this(null);
    }

    public FileProcessService(Consumer<String> handler) {
        this.handler = handler;
        this.processor = new ThreadPoolExecutor(
                4, 8, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(100),
                new NamedThreadFactory(),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void process(String fileId) {
        if (handler == null) {
            throw new IllegalStateException("FileProcessService handler is not configured");
        }
        try {
            processor.execute(() -> {
                try {
                    handler.accept(fileId);
                    completed.incrementAndGet();
                } catch (RuntimeException ex) {
                    failed.incrementAndGet();
                    LOGGER.error("File process failed for fileId={}", fileId, ex);
                }
            });
            submitted.incrementAndGet();
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            LOGGER.warn("File process rejected for fileId={}", fileId, ex);
            throw ex;
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> result = new ConcurrentHashMap<>();
        result.put("submitted", submitted.get());
        result.put("completed", completed.get());
        result.put("failed", failed.get());
        result.put("rejected", rejected.get());
        return result;
    }

    public void stop() {
        processor.shutdown();
        boolean terminated = false;
        try {
            terminated = processor.awaitTermination(200L, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            processor.shutdownNow();
            return;
        }
        if (!terminated) {
            processor.shutdownNow();
            try {
                terminated = processor.awaitTermination(200L, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return;
            }
            if (!terminated) {
                throw new IllegalStateException("FileProcessService did not terminate in time");
            }
        }
    }

    static class NamedThreadFactory implements ThreadFactory {
        private final AtomicLong counter = new AtomicLong();

        @Override
        public Thread newThread(Runnable task) {
            Thread thread = new Thread(task, THREAD_NAME_PREFIX + counter.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        }
    }
}