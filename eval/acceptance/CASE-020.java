import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Function;

/** Cancellation must stop an interruptible computation, not just complete a future. */
class AcceptanceTest {
    static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    static boolean causedBy(Throwable error,Class<?> type){
        for(Throwable t=error;t!=null;t=t.getCause())if(type.isInstance(t))return true;
        return false;
    }
    static class Fixture implements AutoCloseable {
        final Object service;
        final ThreadPoolExecutor pool;
        final ThreadLocal<String> tenant;
        final Method export, stop;
        final CountDownLatch entered=new CountDownLatch(1),exited=new CountDownLatch(1),release=new CountDownLatch(1);
        final AtomicBoolean called=new AtomicBoolean(),interrupted=new AtomicBoolean();
        final IllegalArgumentException domainFailure=new IllegalArgumentException("injected export failure");
        Fixture(Class<?> type,long timeoutMillis,String behavior)throws Exception{
            Field context=type.getDeclaredField("TENANT");context.setAccessible(true);
            @SuppressWarnings("unchecked") ThreadLocal<String> local=(ThreadLocal<String>)context.get(null);tenant=local;
            Thread caller=Thread.currentThread();
            Function<String,String> generate=id->{
                called.set(true);entered.countDown();
                try{
                    require(Thread.currentThread()!=caller,"Export ran blocking downstream on its caller");
                    require(Objects.equals(tenant.get(),"tenant-"+id),"Worker tenant not propagated to real generator");
                    if(behavior.equals("failure"))throw domainFailure;
                    if(behavior.equals("blocked")){
                        try{release.await();}
                        catch(InterruptedException error){interrupted.set(true);Thread.currentThread().interrupt();throw new IllegalStateException("worker interrupted",error);}
                    }
                    if(behavior.equals("uninterruptible")){
                        for(;;){
                            try{release.await();break;}
                            catch(InterruptedException error){interrupted.set(true);}
                        }
                    }
                    return "report-"+id;
                }finally{exited.countDown();}
            };
            service=type.getConstructor(long.class,Function.class).newInstance(timeoutMillis,generate);
            export=type.getMethod("export",String.class);stop=type.getMethod("stop");
            ThreadPoolExecutor found=null;
            for(Field field:type.getDeclaredFields()){
                if(ExecutorService.class.isAssignableFrom(field.getType())){
                    field.setAccessible(true);if(field.get(service)instanceof ThreadPoolExecutor p)found=p;
                }
            }
            require(found!=null,"No observable business ThreadPoolExecutor");pool=found;
            pool.setCorePoolSize(1);pool.setMaximumPoolSize(1);
            pool.submit(()->tenant.set("worker-before")).get(1,TimeUnit.SECONDS);
        }
        Object send(String id)throws Exception{
            try{return export.invoke(service,id);}
            catch(InvocationTargetException error){
                if(error.getCause()instanceof RuntimeException runtime)throw runtime;
                if(error.getCause()instanceof Error fatal)throw fatal;
                throw error;
            }
        }
        Throwable failure(String id)throws Exception{
            try{send(id);}catch(RuntimeException error){return error;}
            throw new AssertionError("Expected export failure for "+id);
        }
        void restoreCheck()throws Exception{
            require("caller-before".equals(tenant.get()),"Caller context was cleared or leaked");
            require("worker-before".equals(pool.submit(tenant::get).get(1,TimeUnit.SECONDS)),"Worker context was not restored after export");
        }
        void stop()throws Exception{stop.invoke(service);}
        public void close()throws Exception{
            release.countDown();pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);tenant.remove();
        }
    }
    static class Invocation {
        final CompletableFuture<Throwable> error=new CompletableFuture<>();
        final AtomicReference<String> afterContext=new AtomicReference<>();
        final AtomicBoolean interruptFlag=new AtomicBoolean();
        final Thread thread;
        Invocation(Fixture f,String id){
            thread=new Thread(()->{
                f.tenant.set("caller-before");Throwable failure=null;
                try{f.send(id);}catch(Throwable error){failure=error;}
                finally{
                    afterContext.set(f.tenant.get());interruptFlag.set(Thread.currentThread().isInterrupted());
                    f.tenant.remove();error.complete(failure);
                }
            },"acceptance-export-caller");thread.setDaemon(true);thread.start();
        }
        void clean()throws Exception{thread.interrupt();thread.join(1000);}
    }
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0]);
        if(args.length>1){
            require(args.length==2&&(args[1].equals("queued-shutdown")||args[1].equals("uninterruptible-shutdown")),"Unknown export acceptance scenario");
            if(args[1].equals("queued-shutdown"))verifyQueuedShutdown(type);
            else verifyUninterruptibleShutdown(type);
            return;
        }
        // Default behavior and injected behavior must both preserve the original public result.
        Object defaults=type.getConstructor().newInstance();
        try{require("report-default".equals(type.getMethod("export",String.class).invoke(defaults,"default")),"Default export result changed");}
        finally{type.getMethod("stop").invoke(defaults);}
        try(Fixture f=new Fixture(type,1000,"normal")){
            f.tenant.set("caller-before");
            require("report-normal".equals(f.send("normal")),"Wrong generated report");
            require(f.called.get(),"Public export omitted real generator");f.restoreCheck();
            f.tenant.remove();require("report-empty-caller".equals(f.send("empty-caller")),"Empty-context export failed");
            require(f.tenant.get()==null,"Empty caller context leaked after export");
            require("worker-before".equals(f.pool.submit(f.tenant::get).get(1,TimeUnit.SECONDS)),"Worker context leaked for empty caller");
        }
        try(Fixture f=new Fixture(type,1000,"failure")){
            f.tenant.set("caller-before");Throwable error=f.failure("failure");
            require(causedBy(error,IllegalArgumentException.class),"Generator failure cause lost");f.restoreCheck();
        }
        try(Fixture f=new Fixture(type,300,"blocked")){
            f.tenant.set("caller-before");Throwable error=f.failure("timeout");
            require(causedBy(error,TimeoutException.class),"Expected explicit timeout cause");
            require(f.entered.getCount()==0,"No real computation started before timeout");
            require(f.exited.await(1,TimeUnit.SECONDS)&&f.interrupted.get(),"Timeout cancelled only completion; underlying work kept running");
            f.restoreCheck();
        }
        try(Fixture f=new Fixture(type,5000,"blocked")){
            Invocation caller=new Invocation(f,"caller-interrupted");
            try{
                require(f.entered.await(1,TimeUnit.SECONDS),"Interrupt target never started");caller.thread.interrupt();
                Throwable error=caller.error.get(1,TimeUnit.SECONDS);
                require(causedBy(error,InterruptedException.class),"Caller interruption cause lost");
                require(caller.interruptFlag.get(),"Caller interrupt flag swallowed");
                require("caller-before".equals(caller.afterContext.get()),"Interrupted caller context leaked");
                require(f.exited.await(1,TimeUnit.SECONDS)&&f.interrupted.get(),"Caller cancellation did not stop underlying work");
                require("worker-before".equals(f.pool.submit(f.tenant::get).get(1,TimeUnit.SECONDS)),"Cancelled worker context leaked");
            }finally{caller.clean();}
        }
        // A queued timeout must remove work without invoking the generator later.
        try(Fixture f=new Fixture(type,150,"normal")){
            CountDownLatch worker=new CountDownLatch(1),unblock=new CountDownLatch(1);
            try{
                f.pool.execute(()->{worker.countDown();try{unblock.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
                require(worker.await(1,TimeUnit.SECONDS),"Could not occupy export worker");
                f.tenant.set("caller-before");require(causedBy(f.failure("queued-timeout"),TimeoutException.class),"Queued export did not time out");
                require(f.pool.getQueue().isEmpty(),"Cancelled queued export still consumes capacity; remove the actual queued Runnable, which may differ from an inner FutureTask");
                unblock.countDown();f.pool.submit(()->{}).get(1,TimeUnit.SECONDS);
                require(!f.called.get(),"Cancelled queued export ran later");f.restoreCheck();
            }finally{unblock.countDown();}
        }
        // Saturation is rejected synchronously and records the original report for compensation.
        try(Fixture f=new Fixture(type,1000,"normal")){
            CountDownLatch worker=new CountDownLatch(1),unblock=new CountDownLatch(1);
            try{
                f.pool.execute(()->{worker.countDown();try{unblock.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
                require(worker.await(1,TimeUnit.SECONDS),"Could not saturate export worker");
                int capacity=f.pool.getQueue().remainingCapacity();require(capacity>0&&capacity<=10000,"Unbounded export queue");
                for(int i=0;i<capacity;i++)f.pool.execute(()->{});
                f.tenant.set("caller-before");require(causedBy(f.failure("overloaded"),RejectedExecutionException.class),"Overload rejection lost");
                Field pending=type.getDeclaredField("pendingReports");pending.setAccessible(true);
                require(pending.get(f.service)instanceof Queue<?> q&&q.contains("overloaded"),"Rejected report not retained for compensation");
                require("caller-before".equals(f.tenant.get()),"Rejected caller context leaked");
            }finally{unblock.countDown();}
        }
        verifyQueuedShutdown(type);
        verifyUninterruptibleShutdown(type);
        // Graceful and repeated stop wait for the same accepted callback to finish.
        try(Fixture f=new Fixture(type,5000,"blocked")){
            Invocation caller=new Invocation(f,"graceful");ExecutorService closers=Executors.newFixedThreadPool(2);
            try{
                require(f.entered.await(1,TimeUnit.SECONDS),"Graceful target never started");
                Future<?> first=closers.submit(()->{try{f.stop();}catch(Exception e){throw new RuntimeException(e);}});
                try{first.get(20,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned before accepted export finished");}catch(TimeoutException expected){}
                Future<?> second=closers.submit(()->{try{f.stop();}catch(Exception e){throw new RuntimeException(e);}});
                try{second.get(20,TimeUnit.MILLISECONDS);throw new AssertionError("Repeated stop returned before accepted export finished");}catch(TimeoutException expected){}
                f.release.countDown();first.get(1,TimeUnit.SECONDS);second.get(1,TimeUnit.SECONDS);
                require(caller.error.get(1,TimeUnit.SECONDS)==null,"Graceful shutdown lost accepted export");
                require("caller-before".equals(caller.afterContext.get()),"Graceful caller context leaked");
            }finally{f.release.countDown();closers.shutdownNow();caller.clean();}
        }
    }
    // Independently runnable: an earlier timeout assertion must not hide stranded shutdown callers.
    static void verifyQueuedShutdown(Class<?> type)throws Exception{
        // Forced shutdown must wake a caller whose task has not yet started.
        try(Fixture f=new Fixture(type,5000,"normal")){
            CountDownLatch worker=new CountDownLatch(1),unblock=new CountDownLatch(1);
            Invocation caller=null;
            try{
                f.pool.execute(()->{worker.countDown();try{unblock.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
                require(worker.await(1,TimeUnit.SECONDS),"Could not occupy shutdown worker");caller=new Invocation(f,"shutdown-queued");
                long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(1);
                while(f.pool.getQueue().isEmpty()&&System.nanoTime()<end)Thread.sleep(2);
                require(!f.pool.getQueue().isEmpty(),"Shutdown target was not queued");
                f.stop();Throwable error;
                try{error=caller.error.get(1,TimeUnit.SECONDS);}
                catch(TimeoutException timeout){throw new AssertionError("Shutdown stranded queued export caller; shutdownNow does not automatically complete results of drained tasks",timeout);}
                require(error!=null&&!causedBy(error,TimeoutException.class),"Shutdown left caller waiting for ordinary timeout");
                require(!f.called.get(),"Shutdown executed cancelled queued work");
                require("caller-before".equals(caller.afterContext.get()),"Shutdown caller context leaked");
                require(f.pool.isTerminated(),"stop returned before pool terminated");
                f.tenant.set("caller-before");require(causedBy(f.failure("after-stop"),RejectedExecutionException.class),"Closed exporter accepted work");
                require("caller-before".equals(f.tenant.get()),"Closed exporter changed caller context");
            }finally{unblock.countDown();if(caller!=null)caller.clean();}
        }
    }

    static void verifyUninterruptibleShutdown(Class<?> type)throws Exception{
        try(Fixture f=new Fixture(type,5000,"uninterruptible")){
            Invocation caller=new Invocation(f,"uninterruptible");
            ExecutorService closer=Executors.newSingleThreadExecutor();
            try{
                require(f.entered.await(1,TimeUnit.SECONDS),"Uninterruptible target never started");
                Future<Throwable> result=closer.submit(()->{try{f.stop();return null;}catch(Throwable error){return error;}});
                Throwable failure;
                try{failure=result.get(2,TimeUnit.SECONDS);}
                catch(TimeoutException timeout){throw new AssertionError("stop waits without bound for an uninterruptible callback",timeout);}
                require(failure!=null,"stop reported success while uninterruptible work was still running; report termination failure to the caller");
                require(f.interrupted.get(),"Forced stop did not interrupt active export work");
                require(!f.pool.isTerminated(),"Uninterruptible fixture unexpectedly terminated before release");
            }finally{
                f.release.countDown();closer.shutdownNow();caller.clean();
            }
        }
    }

}
