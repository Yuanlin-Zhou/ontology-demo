package com.example.schedule.service;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.Objects;
import java.util.Queue;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** Periodic retry adapter; the host supplies the actual payment retry operation. */
public class RetryScheduler {
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(RetryScheduler.class);
    private final Queue<String> pendingRetries=new ConcurrentLinkedQueue<>();
    private final Object lifecycle=new Object();
    private final ScheduledThreadPoolExecutor scheduler=new ScheduledThreadPoolExecutor(
            4,namedFactory("order-retry"),new ThreadPoolExecutor.AbortPolicy());
    private final long initialDelayMillis,delayMillis;
    private final Consumer<String> retryHandler;

    /** Retained for API compatibility; scheduling requires an explicitly configured downstream. */
    public RetryScheduler(){
        initialDelayMillis=1000;delayMillis=30000;retryHandler=null;configureShutdown();
    }
    public RetryScheduler(long initialDelayMillis,long delayMillis,Consumer<String> retryHandler){
        if(initialDelayMillis<0||delayMillis<=0)throw new IllegalArgumentException("Invalid retry delay");
        this.initialDelayMillis=initialDelayMillis;this.delayMillis=delayMillis;
        this.retryHandler=Objects.requireNonNull(retryHandler);configureShutdown();
    }
    private void configureShutdown(){
        scheduler.setRemoveOnCancelPolicy(true);
        scheduler.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        scheduler.setContinueExistingPeriodicTasksAfterShutdownPolicy(false);
    }
    public void scheduleRetry(String orderId){
        Objects.requireNonNull(orderId);
        if(retryHandler==null)throw new IllegalStateException("Configure a payment retry callback before scheduling");
        synchronized(lifecycle){
            try{
                scheduler.scheduleWithFixedDelay(()->{
                    try{retry(orderId);}
                    catch(RuntimeException error){log.warn("retry failed, order={}",orderId,error);}
                },initialDelayMillis,delayMillis,TimeUnit.MILLISECONDS);
            }catch(RejectedExecutionException error){
                pendingRetries.offer(orderId);log.error("retry task rejected, order={}",orderId,error);throw error;
            }
        }
    }
    public String stats(){return scheduler.getActiveCount()+"/"+scheduler.getQueue().size();}
    @PreDestroy
    public void stop(){
        synchronized(lifecycle){scheduler.shutdown();}
        try{
            if(!scheduler.awaitTermination(200,TimeUnit.MILLISECONDS)){
                List<Runnable> pending=scheduler.shutdownNow();
                log.warn("{} retry registrations removed at forced shutdown",pending.size());
                if(!scheduler.awaitTermination(500,TimeUnit.MILLISECONDS))
                    throw new IllegalStateException("Retry work did not stop after interruption");
            }
        }catch(InterruptedException error){
            List<Runnable> pending=scheduler.shutdownNow();
            log.warn("{} retry registrations removed at interrupted shutdown",pending.size());
            Thread.currentThread().interrupt();throw new IllegalStateException("Retry shutdown interrupted",error);
        }
    }
    private void retry(String orderId){retryHandler.accept(orderId);}
    private static ThreadFactory namedFactory(String prefix){
        AtomicInteger sequence=new AtomicInteger();
        return task->new Thread(task,prefix+"-"+sequence.incrementAndGet());
    }
}
