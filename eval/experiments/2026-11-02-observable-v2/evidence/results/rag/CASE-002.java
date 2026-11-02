package com.example.order.service;

import com.example.order.domain.Order;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Function;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * OrderSyncService: 订单数据同步任务。
 *
 * <p>使用可观察的实例 {@link ThreadPoolExecutor} 执行异步同步任务，回调在池内工作线程执行；
 * 通过 {@link ThreadLocal} 传递租户上下文，并在任务结束时恢复工作线程原值，避免线程复用串数据。
 * 回调异常被捕获、计数并记录日志，不传播到提交调用者，也不阻断后续任务。</p>
 */
public class OrderSyncService {

    private static final Logger LOG = LoggerFactory.getLogger(OrderSyncService.class);

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    private static final int CORE_POOL_SIZE = 8;
    private static final int MAX_POOL_SIZE = 8;
    private static final int QUEUE_CAPACITY = 256;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final long RELOAD_TIMEOUT_MILLIS = 5_000L;
    private static final long STOP_GRACE_MILLIS = 200L;
    private static final long STOP_FORCE_WAIT_MILLIS = 1_000L;

    private final Consumer<Order> synchronizer;
    private final Function<String, Order> loader;

    private final ThreadPoolExecutor syncExecutor;

    private final AtomicLong submitted = new AtomicLong();
    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    /**
     * 无参构造：保留原公开接口。未配置下游时业务入口同步抛 IllegalStateException。
     */
    public OrderSyncService() {
        this(null, null);
    }

    /**
     * 配置构造：注入同步与加载回调。拒绝 null。
     */
    public OrderSyncService(Consumer<Order> synchronizer, Function<String, Order> loader) {
        this.synchronizer = synchronizer;
        this.loader = loader;
        this.syncExecutor = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                runnable -> {
                    Thread thread = new Thread(runnable, "order-sync-worker");
                    thread.setDaemon(false);
                    return thread;
                },
                new ThreadPoolExecutor.AbortPolicy());
    }

    /**
     * 异步同步新建订单。回调在池内工作线程执行，租户上下文在 finally 中恢复。
     */
    public void syncCreated(Order order) {
        Objects.requireNonNull(order, "order must not be null");
        requireConfigured();
        try {
            syncExecutor.execute(() -> runSyncTask(order));
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            LOG.warn("Order sync task rejected, orderId={}, tenantId={}",
                    order.id(), order.tenantId(), ex);
            throw ex;
        }
        submitted.incrementAndGet();
    }

    /**
     * 在业务线程池中加载订单，带超时等待；超时或中断时取消任务并保留异常原因与中断状态。
     */
    public Order reload(String id) throws Exception {
        Objects.requireNonNull(id, "id must not be null");
        requireConfigured();
        Future<Order> future;
        try {
            future = syncExecutor.submit(() -> loader.apply(id));
        } catch (RejectedExecutionException ex) {
            rejected.incrementAndGet();
            LOG.warn("Order reload task rejected, orderId={}", id, ex);
            throw ex;
        }
        try {
            return future.get(RELOAD_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException ex) {
            future.cancel(true);
            throw ex;
        } catch (InterruptedException ex) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw ex;
        } catch (ExecutionException ex) {
            Throwable cause = ex.getCause();
            if (cause instanceof Exception e) {
                throw e;
            }
            if (cause instanceof Error e) {
                throw e;
            }
            throw ex;
        }
    }

    /**
     * 统计异步入口指标：submitted / completed / failed / rejected。
     */
    public Map<String, Long> stats() {
        Map<String, Long> snapshot = new ConcurrentHashMap<>();
        snapshot.put("submitted", submitted.get());
        snapshot.put("completed", completed.get());
        snapshot.put("failed", failed.get());
        snapshot.put("rejected", rejected.get());
        return snapshot;
    }

    /**
     * 停止准入并等待已接受任务完成；宽限期后强制关闭，处理未执行任务并再次有界等待。
     */
    public void stop() {
        syncExecutor.shutdown();
        try {
            if (!syncExecutor.awaitTermination(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                syncExecutor.shutdownNow();
                if (!syncExecutor.awaitTermination(STOP_FORCE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("OrderSyncService executor did not terminate in time");
                }
            }
        } catch (InterruptedException ex) {
            syncExecutor.shutdownNow();
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while stopping OrderSyncService", ex);
        }
    }

    private void runSyncTask(Order order) {
        String previous = TENANT.get();
        try {
            TENANT.set(order.tenantId());
            synchronizer.accept(order);
            completed.incrementAndGet();
        } catch (RuntimeException ex) {
            failed.incrementAndGet();
            LOG.error("Order sync callback failed, orderId={}, tenantId={}",
                    order.id(), order.tenantId(), ex);
        } finally {
            if (previous == null) {
                TENANT.remove();
            } else {
                TENANT.set(previous);
            }
        }
    }

    private void requireConfigured() {
        if (synchronizer == null || loader == null) {
            throw new IllegalStateException("OrderSyncService downstream callbacks are not configured");
        }
    }
}