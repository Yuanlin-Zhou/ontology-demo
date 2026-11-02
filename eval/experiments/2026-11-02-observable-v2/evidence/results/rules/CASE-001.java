package com.example.order.service;

import com.example.order.domain.Order;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 订单异步通知服务。
 *
 * <p>使用显式创建的有界线程池执行通知回调；通知失败不影响下单主流程。
 */
public class OrderAsyncService {

    private static final Logger LOGGER = LoggerFactory.getLogger(OrderAsyncService.class);

    private static final int QUEUE_CAPACITY = 1024;
    private static final int CORE_POOL_SIZE = 4;
    private static final int MAX_POOL_SIZE = 16;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 1000L;

    private final Consumer<Order> sender;

    private final ThreadPoolExecutor notifier;

    private final AtomicInteger submitted = new AtomicInteger();
    private final AtomicInteger completed = new AtomicInteger();
    private final AtomicInteger failed = new AtomicInteger();
    private final AtomicInteger rejected = new AtomicInteger();

    private volatile boolean accepting = true;

    public OrderAsyncService() {
        this(null);
    }

    public OrderAsyncService(Consumer<Order> sender) {
        this.sender = sender;
        BlockingQueue<Runnable> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
        ThreadFactory threadFactory = new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger();

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "order-notify-" + seq.incrementAndGet());
                t.setDaemon(false);
                return t;
            }
        };
        this.notifier = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                queue,
                threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void notifyCreated(Order order) {
        Objects.requireNonNull(order, "order");
        if (!accepting) {
            rejected.incrementAndGet();
            LOGGER.warn("Order notification rejected because service is stopping, orderId={}", order.id());
            throw new RejectedExecutionException("OrderAsyncService is stopped");
        }
        Consumer<Order> target = this.sender;
        if (target == null) {
            throw new IllegalStateException("OrderAsyncService sender is not configured");
        }
        try {
            notifier.execute(() -> runTask(target, order));
            submitted.incrementAndGet();
        } catch (RejectedExecutionException e) {
            rejected.incrementAndGet();
            LOGGER.warn("Order notification rejected, orderId={}", order.id(), e);
            throw e;
        }
    }

    private void runTask(Consumer<Order> target, Order order) {
        try {
            target.accept(order);
            completed.incrementAndGet();
        } catch (RuntimeException e) {
            failed.incrementAndGet();
            LOGGER.error("Order notification failed, orderId={}", order.id(), e);
        }
    }

    public Map<String, Long> stats() {
        Map<String, Long> result = new ConcurrentHashMap<>();
        result.put("submitted", (long) submitted.get());
        result.put("completed", (long) completed.get());
        result.put("failed", (long) failed.get());
        result.put("rejected", (long) rejected.get());
        return result;
    }

    public void stop() {
        accepting = false;
        notifier.shutdown();
        boolean interrupted = false;
        try {
            if (!notifier.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                notifier.shutdownNow();
                if (!notifier.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("OrderAsyncService did not terminate in time");
                }
            }
        } catch (InterruptedException e) {
            interrupted = true;
            notifier.shutdownNow();
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }
}