package com.example.config;

import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/** good.java: Bean 托管线程池 + 监控出口（由容器负责 destroy）。 */
@Configuration
public class AsyncExecutorConfig {

    @Bean("orderNotifier")
    public ThreadPoolTaskExecutor orderNotifier() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("order-notify-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        return executor;
    }

    /** 暴露队列积压与活跃线程数，供监控系统采集。 */
    public static String stats(ThreadPoolTaskExecutor executor) {
        ThreadPoolExecutor delegate = executor.getThreadPoolExecutor();
        return delegate.getActiveCount() + "/" + delegate.getQueue().size() + "/" + delegate.getCompletedTaskCount();
    }
}
