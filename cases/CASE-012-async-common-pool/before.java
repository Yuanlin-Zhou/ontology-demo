package com.example.quote.service;

import java.util.concurrent.CompletableFuture;

/** before.java: 使用 CompletableFuture 编排远程报价，但没有指定业务线程池。 */
public class QuoteService {

    public CompletableFuture<String> quote(String orderId) {
        return CompletableFuture.supplyAsync(() -> remoteQuote(orderId));
    }

    private String remoteQuote(String orderId) {
        return "quote-" + orderId;
    }
}
