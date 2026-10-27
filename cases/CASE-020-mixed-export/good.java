package com.example.export.service;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.logging.Logger;

/** CompletableFuture composition with a separate, interruptible execution handle. */
public class ExportOrchestrator {
    private static final Logger LOG=Logger.getLogger(ExportOrchestrator.class.getName());
    private static final ThreadLocal<String> TENANT=new ThreadLocal<>();
    private final ThreadPoolExecutor exportExecutor=new ThreadPoolExecutor(
            2,2,60L,TimeUnit.SECONDS,new ArrayBlockingQueue<>(16),namedFactory("export"),new ThreadPoolExecutor.AbortPolicy());
    private final Queue<String> pendingReports=new ConcurrentLinkedQueue<>();
    private final Map<FutureTask<Void>,CompletableFuture<String>> outstanding=new ConcurrentHashMap<>();
    private final Function<String,String> generator;
    private final long timeoutMillis;
    private final Object lifecycle=new Object();
    private boolean closed;

    public ExportOrchestrator(){this(30000,id->"report-"+id);}
    public ExportOrchestrator(long timeoutMillis,Function<String,String> generator){
        if(timeoutMillis<=0)throw new IllegalArgumentException("timeoutMillis must be positive");
        this.timeoutMillis=timeoutMillis;this.generator=Objects.requireNonNull(generator);
    }
    public String export(String reportId){
        String callerPrevious=TENANT.get();
        try{
            validateTenant(reportId);
            CompletableFuture<String> result=new CompletableFuture<>();
            FutureTask<Void> task=new FutureTask<Void>(()->{
                String workerPrevious=TENANT.get();
                try{
                    TENANT.set(tenantOf(reportId));
                    result.complete(generator.apply(reportId));
                }catch(Throwable error){result.completeExceptionally(error);}
                finally{restore(workerPrevious);}
                return null;
            }){
                @Override protected void done(){
                    outstanding.remove(this);
                    if(isCancelled())result.cancel(false);
                }
            };
            synchronized(lifecycle){
                if(closed){pendingReports.offer(reportId);throw new RejectedExecutionException("Exporter closed");}
                outstanding.put(task,result);
                try{exportExecutor.execute(task);}
                catch(RejectedExecutionException error){
                    task.cancel(false);pendingReports.offer(reportId);
                    LOG.warning("Export rejected: "+reportId);throw error;
                }
            }
            // Completion and composition are separate from ownership of the running computation.
            CompletableFuture<String> delivery=result.thenApply(value->value);
            try{return delivery.get(timeoutMillis,TimeUnit.MILLISECONDS);}
            catch(TimeoutException error){
                cancelWork(task);
                throw new IllegalStateException("export timeout",error);
            }catch(InterruptedException error){
                cancelWork(task);Thread.currentThread().interrupt();
                throw new IllegalStateException("export interrupted",error);
            }catch(ExecutionException error){
                Throwable cause=error.getCause();
                while(cause instanceof CompletionException && cause.getCause()!=null)cause=cause.getCause();
                throw new IllegalStateException("export failed",cause);
            }catch(CancellationException error){throw new IllegalStateException("export cancelled",error);}
        }finally{restore(callerPrevious);}
    }
    private void cancelWork(FutureTask<Void> task){
        task.cancel(true);
        // Cancelled queued work must not consume capacity until some worker eventually polls it.
        exportExecutor.remove(task);
    }
    public String stats(){return exportExecutor.getActiveCount()+"/"+exportExecutor.getQueue().size()+"/"+exportExecutor.getCompletedTaskCount();}
    @jakarta.annotation.PreDestroy
    public void stop(){
        synchronized(lifecycle){closed=true;exportExecutor.shutdown();}
        try{
            if(!exportExecutor.awaitTermination(200,TimeUnit.MILLISECONDS)){
                List<Runnable> pending=exportExecutor.shutdownNow();
                LOG.warning("Forced shutdown, pending exports: "+pending.size());
                // Includes tasks removed from the executor queue and still-running computations.
                for(FutureTask<Void> task:outstanding.keySet())task.cancel(true);
                if(!exportExecutor.awaitTermination(500,TimeUnit.MILLISECONDS))
                    throw new IllegalStateException("Export work did not stop after interruption");
            }
        }catch(InterruptedException error){
            List<Runnable> pending=exportExecutor.shutdownNow();
            LOG.warning("Interrupted shutdown, pending exports: "+pending.size());
            for(FutureTask<Void> task:outstanding.keySet())task.cancel(true);
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Export shutdown interrupted",error);
        }
    }
    private void validateTenant(String reportId){
        Objects.requireNonNull(reportId);
        if(TENANT.get()==null)TENANT.set(tenantOf(reportId));
    }
    private String tenantOf(String reportId){return "tenant-"+reportId;}
    private static void restore(String previous){if(previous==null)TENANT.remove();else TENANT.set(previous);}
    private static ThreadFactory namedFactory(String prefix){
        AtomicInteger sequence=new AtomicInteger();
        return runnable->{
            Thread thread=new Thread(runnable,prefix+"-"+sequence.incrementAndGet());
            thread.setUncaughtExceptionHandler((t,error)->LOG.severe("Export worker failed: "+error));
            return thread;
        };
    }
}
