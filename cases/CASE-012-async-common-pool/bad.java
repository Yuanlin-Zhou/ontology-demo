package com.example.quote.service;

import java.util.concurrent.CompletableFuture;

/** bad.java: 阻塞式远程调用跑在公共 ForkJoinPool 上，还缺少超时控制。 */
public class QuoteService {

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture.supplyAsync(() -> remoteQuote(orderId));
    }

    public String quoteNow(String orderId) {
        CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> remoteQuote(orderId));
        return future.join();
    }

    private String remoteQuote(String orderId) {
        return "quote-" + orderId;
    }
}
