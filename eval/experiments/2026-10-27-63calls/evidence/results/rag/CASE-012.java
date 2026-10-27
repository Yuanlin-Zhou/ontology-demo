package com.example.quote.service;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/** before.java: 使用 CompletableFuture 编排远程报价，但没有指定业务线程池。 */
public class QuoteService {

    private static final long QUOTE_TIMEOUT_SECONDS = 2L;

    private final ExecutorService quoteExecutor;

    public QuoteService() {
        this.quoteExecutor = Executors.newFixedThreadPool(8, new ThreadFactory() {
            private final AtomicInteger counter = new AtomicInteger();

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "quote-executor-" + counter.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        });
    }

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture
                .supplyAsync(() -> remoteQuote(orderId), quoteExecutor)
                .orTimeout(QUOTE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .exceptionallyCompose(ex -> {
                    Throwable cause = ex;
                    while (cause != null && !(cause instanceof TimeoutException)) {
                        cause = cause.getCause();
                    }
                    if (cause instanceof TimeoutException) {
                        return CompletableFuture.failedFuture(new TimeoutException(
                                "quote timed out for order " + orderId));
                    }
                    return CompletableFuture.failedFuture(ex);
                });
    }

    private String remoteQuote(String orderId) {
        return "quote-" + orderId;
    }
}