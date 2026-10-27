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
            private final AtomicInteger seq = new AtomicInteger(0);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "notification-send-" + seq.incrementAndGet());
                t.setDaemon(false);
                t.setUncaughtExceptionHandler((thread, ex) -> {
                    // 统一兜底：任务内异常不向外传播，也不影响后续任务
                    System.err.println("notification-send uncaught exception on "
                            + thread.getName() + ": " + ex);
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
                    // 显式拒绝策略：不阻塞调用方，丢弃并计数（远程通知失败可容忍）
                    rejectedCount.incrementAndGet();
                });
    }

    public void notifyCreated(Runnable send) {
        if (send == null) {
            return;
        }
        Runnable task = () -> {
            try {
                send.run();
            } catch (Throwable t) {
                // 远程通知失败不能传播到调用方，也不能导致后续通知停止
                System.err.println("notification send failed: " + t);
            }
        };
        try {
            pool.execute(task);
        } catch (RejectedExecutionException e) {
            // 关闭后或拒绝时安全返回
            rejectedCount.incrementAndGet();
        } catch (Throwable t) {
            // 任何提交异常都不传播到调用方
            rejectedCount.incrementAndGet();
        }
    }

    @Override
    public void close() {
        pool.shutdown();
        boolean interrupted = false;
        try {
            if (!pool.awaitTermination(CLOSE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
                pool.shutdownNow();
                try {
                    pool.awaitTermination(CLOSE_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        } catch (InterruptedException e) {
            interrupted = true;
            pool.shutdownNow();
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
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