package com.example.file.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 线程工厂设置业务前缀 + 拒绝补偿 + 监控 + 优雅关闭。 */
public class FileProcessService {

    private final ThreadPoolExecutor processor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100),
            new NamedThreadFactory("file-process"),
            new ThreadPoolExecutor.AbortPolicy());

    public void process(String fileId) {
        try {
            processor.execute(() -> handle(fileId));
        } catch (RejectedExecutionException ex) {
            log.error("file process rejected, file={}", fileId, ex);
            retryQueue.offer(fileId);
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return processor.getActiveCount() + "/" + processor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        processor.shutdown();
        try {
            if (!processor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = processor.shutdownNow();
                log.warn("{} files were not processed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = processor.shutdownNow();
            log.warn("shutdown interrupted, {} files left", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    private void handle(String fileId) {
    }

    static class NamedThreadFactory implements ThreadFactory {
        private final AtomicInteger sequence = new AtomicInteger();
        private final String prefix;

        NamedThreadFactory(String prefix) {
            this.prefix = prefix;
        }

        @Override
        public Thread newThread(Runnable task) {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        }
    }
}
