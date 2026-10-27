import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public class NotificationService implements AutoCloseable {

    private static final int CORE_POOL_SIZE = 2;
    private static final int MAX_POOL_SIZE = 4;
    private static final long KEEP_ALIVE_SECONDS = 60L;
    private static final int QUEUE_CAPACITY = 256;
    private static final long CLOSE_TIMEOUT_MILLIS = 2000L;

    private final AtomicLong rejectedCount = new AtomicLong(0L);

    private final ThreadPoolExecutor pool;

    public NotificationService() {
        ThreadFactory threadFactory = new ThreadFactory() {
            private final AtomicInteger index = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "notification-send-" + index.getAndIncrement());
                t.setDaemon(false);
                t.setUncaughtExceptionHandler((thread, ex) -> {
                    // 统一上报，避免默认打印到标准错误
                    System.err.println("Uncaught exception in " + thread.getName() + ": " + ex);
                });
                return t;
            }
        };

        this.pool = new ThreadPoolExecutor(
                CORE_POOL_SIZE,
                MAX_POOL_SIZE,
                KEEP_ALIVE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                threadFactory,
                (r, executor) -> {
                    // 显式拒绝策略：记录拒绝次数并丢弃，保证调用方安全返回
                    rejectedCount.incrementAndGet();
                }
        );
    }

    public void notifyCreated(Runnable send) {
        if (send == null) {
            return;
        }
        try {
            pool.execute(() -> {
                try {
                    send.run();
                } catch (Throwable t) {
                    // 远程通知失败不能传播，也不能影响后续通知
                    System.err.println("Notification send failed: " + t);
                }
            });
        } catch (RejectedExecutionException e) {
            // 关闭后或队列满时安全返回
            rejectedCount.incrementAndGet();
        } catch (Throwable t) {
            // 兜底，确保不向调用方传播
            System.err.println("Notification submit failed: " + t);
        }
    }

    @Override
    public void close() {
        pool.shutdown();
        boolean terminated = false;
        try {
            terminated = pool.awaitTermination(CLOSE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (!terminated) {
                pool.shutdownNow();
                try {
                    pool.awaitTermination(CLOSE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    // 可观测性：暴露线程池指标
    public int getQueueSize() {
        return pool.getQueue().size();
    }

    public int getActiveCount() {
        return pool.getActiveCount();
    }

    public long getCompletedTaskCount() {
        return pool.getCompletedTaskCount();
    }

    public long getTaskCount() {
        return pool.getTaskCount();
    }

    public long getRejectedCount() {
        return rejectedCount.get();
    }
}