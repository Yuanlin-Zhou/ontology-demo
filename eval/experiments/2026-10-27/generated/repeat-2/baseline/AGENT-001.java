import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

public class NotificationService implements AutoCloseable {

    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    public NotificationService() {
    }

    public void notifyCreated(Runnable send) {
        if (send == null) {
            return;
        }
        try {
            pool.execute(() -> {
                try {
                    send.run();
                } catch (Throwable ignored) {
                    // 远程通知失败不能传播到调用方，也不能阻止后续通知
                }
            });
        } catch (RejectedExecutionException ignored) {
            // 关闭后提交必须安全返回
        }
    }

    @Override
    public void close() {
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