import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public class EventPublisher {
    private final Consumer<String> receiver;
    private final ThreadPoolExecutor executor;

    public EventPublisher(Consumer<String> receiver) {
        this.receiver = Objects.requireNonNull(receiver);
        this.executor = new ThreadPoolExecutor(
                1,
                1,
                0L,
                TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(2),
                new ThreadPoolExecutor.AbortPolicy());
    }

    public void publish(String event) {
        executor.execute(() -> {
            try {
                receiver.accept(event);
            } catch (RuntimeException ex) {
                System.err.println("Event callback failed: " + ex);
            }
        });
    }

    public void stop() {
        executor.shutdown();
        boolean interrupted = false;
        while (true) {
            try {
                if (executor.awaitTermination(Long.MAX_VALUE, TimeUnit.NANOSECONDS)) {
                    break;
                }
            } catch (InterruptedException ex) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}