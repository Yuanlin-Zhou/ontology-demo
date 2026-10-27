package com.example.quote.service;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** before.java: 使用 CompletableFuture 编排远程报价，但没有指定业务线程池。 */
public class QuoteService {

    private static final long TIMEOUT_SECONDS = 2L;

    private final ExecutorService businessExecutor = Executors.newFixedThreadPool(
            Math.max(2, Runtime.getRuntime().availableProcessors()));

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture
                .supplyAsync(() -> remoteQuote(orderId), businessExecutor)
                .orTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
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