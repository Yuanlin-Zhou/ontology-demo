package com.example.order.service;

import com.example.order.domain.Order;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 订单异步通知服务。
 *
 * <p>订单创建后异步发送通知，通知失败不影响下单主流程。</p>
 */
public class OrderAsyncService {

    private static final Logger log = LoggerFactory.getLogger(OrderAsyncService.class);

    private static final int CORE_POOL_SIZE = 16;
    private static final int MAX_POOL_SIZE = 16;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 1024;

    private final AtomicLong rejectedCount = new AtomicLong(0L);

    private final ThreadPoolExecutor notifier;

    public OrderAsyncService() {
        this.notifier = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(QUEUE_CAPACITY),
                new NotifierThreadFactory(),
                new ThreadPoolExecutor.AbortPolicy());
        this.notifier.allowCoreThreadTimeOut(false);
    }

    public void notifyCreated(Order order) {
        if (order == null) {
            return;
        }
        try {
            notifier.execute(() -> sendRemote(order));
        } catch (RejectedExecutionException ex) {
            rejectedCount.incrementAndGet();
            log.warn("Order notification rejected, orderId={}, tenantId={}, queueSize={}, activeCount={}",
                    order.id(), order.tenantId(),
                    notifier.getQueue().size(), notifier.getActiveCount());
        }
    }

    private void sendRemote(Order order) {
        try {
            // remote call to the notification platform
        } catch (RuntimeException ex) {
            log.warn("Order notification failed, orderId={}, tenantId={}",
                    order.id(), order.tenantId(), ex);
        }
    }

    public long getRejectedCount() {
        return rejectedCount.get();
    }

    public int getQueueSize() {
        return notifier.getQueue().size();
    }

    public int getActiveCount() {
        return notifier.getActiveCount();
    }

    public long getCompletedTaskCount() {
        return notifier.getCompletedTaskCount();
    }

    public long getTaskCount() {
        return notifier.getTaskCount();
    }

    public void shutdown() {
        notifier.shutdown();
        try {
            if (!notifier.awaitTermination(30, TimeUnit.SECONDS)) {
                notifier.shutdownNow();
            }
        } catch (InterruptedException ex) {
            notifier.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private static final class NotifierThreadFactory implements ThreadFactory {
        private final AtomicInteger seq = new AtomicInteger(0);

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "order-notify-" + seq.incrementAndGet());
            t.setDaemon(false);
            return t;
        }
    }
}