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
                    // 统一兜底：任务内异常不向外传播，仅记录
                    System.err.println("[NotificationService] uncaught exception in " + thread.getName() + ": " + ex);
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
        Runnable safeTask = () -> {
            try {
                send.run();
            } catch (Throwable t) {
                // 远程通知失败不能传播，也不能影响后续通知
                System.err.println("[NotificationService] notification failed: " + t);
            }
        };
        try {
            pool.execute(safeTask);
        } catch (RejectedExecutionException e) {
            // 关闭后或队列满时安全返回
            rejectedCount.incrementAndGet();
        } catch (Throwable t) {
            // 任何提交异常都不传播到调用方
            System.err.println("[NotificationService] submit failed: " + t);
        }
    }

    @Override
    public void close() {
        pool.shutdown();
        try {
            if (!pool.awaitTermination(2, TimeUnit.SECONDS)) {
                pool.shutdownNow();
                pool.awaitTermination(2, TimeUnit.SECONDS);
            }
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    // 可观测性：供监控采集
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