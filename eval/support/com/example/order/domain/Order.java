package com.example.order.domain;

/** Minimal domain input contract for the isolated PoC, not a replacement for a production model. */
public record Order(String id, String tenantId) {}
