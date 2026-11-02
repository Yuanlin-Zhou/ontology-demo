package com.example.order.service;

import com.example.order.domain.Order;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * OrderAsyncService: 订单创建后的异步通知。
 * 通知失败不影响下单主流程；回调在实例 ThreadPoolExecutor 工作线程执行。
 */
public class OrderAsyncService {

    private static final Logger LOG = LoggerFactory.getLogger(OrderAsyncService.class);

    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 16;
    private static final int QUEUE_CAPACITY = 256;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 2000L;

    private final Consumer<Order> sender;

    private final ThreadPoolExecutor notifier;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    private volatile boolean accepting = true;

    public OrderAsyncService() {
        this.sender = null;
        this.notifier = newNotifier();
    }

    public OrderAsyncService(Consumer<Order> sender) {
        this.sender = Objects.requireNonNull(sender, "sender must not be null");
        this.notifier = newNotifier();
    }

    private static ThreadPoolExecutor newNotifier() {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                runnable -> {
                    Thread t = new Thread(runnable, "order-async-notifier");
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.AbortPolicy());
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }

    public void notifyCreated(Order order) {
        Objects.requireNonNull(order, "order must not be null");
        if (!accepting) {
            rejected.incrementAndGet();
            LOG.warn("OrderAsyncService is stopped, rejecting order notification for orderId={}", order.id());
            throw new RejectedExecutionException("OrderAsyncService is stopped");
        }
        if (sender == null) {
            throw new IllegalStateException("OrderAsyncService sender is not configured");
        }
        try {
            notifier.execute(() -> runTask(order));
        } catch (RejectedExecutionException e) {
            rejected.incrementAndGet();
            LOG.warn("OrderAsyncService rejected order notification for orderId={}", order.id(), e);
            throw e;
        }
        submitted.incrementAndGet();
    }

    private void runTask(Order order) {
        try {
            sender.accept(order);
            completed.incrementAndGet();
        } catch (RuntimeException e) {
            failed.incrementAndGet();
            LOG.error("Order notification failed for orderId={}", order.id(), e);
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
        accepting = false;
        notifier.shutdown();
        boolean terminated = false;
        try {
            terminated = notifier.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS);
            if (!terminated) {
                notifier.shutdownNow();
                terminated = notifier.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException e) {
            notifier.shutdownNow();
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while stopping OrderAsyncService", e);
        }
        if (!terminated) {
            throw new IllegalStateException("OrderAsyncService did not terminate in time");
        }
    }
}