import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class NotificationService implements AutoCloseable {

    private final ExecutorService pool;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    public NotificationService() {
        this.pool = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "notification-worker");
            t.setDaemon(true);
            return t;
        });
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
            // 关闭后提交安全返回
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
            }
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}