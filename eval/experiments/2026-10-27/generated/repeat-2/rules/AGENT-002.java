import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public class TimedQuery {

    public static String query(ExecutorService pool, Callable<String> work, long timeoutMillis) {
        if (pool == null || work == null) {
            return "failed";
        }

        Future<String> future;
        try {
            future = pool.submit(work);
        } catch (RejectedExecutionException e) {
            // 线程池拒绝任务（如已关闭或队列满），快速失败返回业务错误码
            return "failed";
        } catch (RuntimeException e) {
            return "failed";
        }

        try {
            return future.get(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            // 超时：取消任务并允许中断
            future.cancel(true);
            return "timeout";
        } catch (InterruptedException e) {
            // 调用线程被中断：先取消任务，再恢复中断标记
            future.cancel(true);
            Thread.currentThread().interrupt();
            return "interrupted";
        } catch (ExecutionException e) {
            // 任务执行异常
            return "failed";
        } catch (RuntimeException e) {
            return "failed";
        }
    }
}