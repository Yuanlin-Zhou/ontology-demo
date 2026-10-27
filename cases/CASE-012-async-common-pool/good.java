package com.example.quote.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** good.java: 异步任务使用独立线程池 + 超时 + 异常处理，线程池可监控可关闭。 */
public class QuoteService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(QuoteService.class);


    private final ThreadPoolExecutor quoteExecutor = new ThreadPoolExecutor(
            8, 16, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            namedFactory("quote-remote"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture.supplyAsync(() -> remoteQuote(orderId), quoteExecutor)
                .orTimeout(2, TimeUnit.SECONDS);
    }

    public String quoteNow(String orderId) {
        try {
            return quote(orderId).join();
        } catch (CompletionException ex) {
            log.warn("quote failed, order={}", orderId, ex.getCause());
            throw new IllegalStateException("quote unavailable", ex.getCause());
        }
    }

    /** 队列积压与活跃线程数，用于监控告警。 */
    public String stats() {
        return quoteExecutor.getActiveCount() + "/" + quoteExecutor.getQueue().size();
    }

    @PreDestroy
    public void stop() {
        quoteExecutor.shutdown();
        try {
            if (!quoteExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                List<Runnable> pending = quoteExecutor.shutdownNow();
                log.warn("{} quote tasks were not executed before shutdown", pending.size());
            }
        } catch (InterruptedException ex) {
            List<Runnable> pending = quoteExecutor.shutdownNow();
            log.warn("shutdown interrupted, {} quote tasks left", pending.size());
            Thread.currentThread().interrupt();
        }
    }

    private static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            return thread;
        };
    }

    private String remoteQuote(String orderId) {
        return "quote-" + orderId;
    }
}
