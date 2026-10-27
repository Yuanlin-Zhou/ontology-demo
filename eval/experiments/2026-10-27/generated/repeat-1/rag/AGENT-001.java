import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public class NotificationService implements AutoCloseable {

    private final ThreadPoolExecutor pool;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public NotificationService() {
        AtomicInteger counter = new AtomicInteger();
        ThreadFactory factory = r -> {
            Thread t = new Thread(r, "notification-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
        this.pool = new ThreadPoolExecutor(
                2, 2,
                0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(),
                factory,
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void notifyCreated(Runnable send) {
        if (send == null) {
            return;
        }
        if (closed.get()) {
            return;
        }
        try {
            pool.execute(() -> {
                try {
                    send.run();
                } catch (Throwable ignored) {
                    // 远程通知失败不能传播到调用方，也不能影响后续通知
                }
            });
        } catch (RejectedExecutionException e) {
            // 关闭后或拒绝时安全返回
        } catch (Throwable ignored) {
            // 任何提交异常都不传播
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
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
}