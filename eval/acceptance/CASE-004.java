import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

/** Real downstream effects, failure isolation, fixed delay and scheduler lifecycle. */
class AcceptanceTest {
    static void require(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    static boolean causedBy(Throwable error,Class<?> kind){
        for(Throwable t=error;t!=null;t=t.getCause())if(kind.isInstance(t))return true;
        return false;
    }
    static class Fixture implements AutoCloseable {
        final Object service;final Method schedule,stop;final ScheduledThreadPoolExecutor pool;
        Fixture(Class<?> type,long initial,long delay,Consumer<String> callback)throws Exception{
            service=type.getConstructor(long.class,long.class,Consumer.class).newInstance(initial,delay,callback);
            schedule=type.getMethod("scheduleRetry",String.class);stop=type.getMethod("stop");
            ScheduledThreadPoolExecutor found=null;
            for(Field field:type.getDeclaredFields())if(ExecutorService.class.isAssignableFrom(field.getType())){
                field.setAccessible(true);if(field.get(service)instanceof ScheduledThreadPoolExecutor p)found=p;
            }
            require(found!=null,"No observable ScheduledThreadPoolExecutor");pool=found;
        }
        void send(String order)throws Exception{schedule.invoke(service,order);}
        void stop()throws Exception{stop.invoke(service);}
        public void close()throws Exception{pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);}
    }
    static void rejectsInvalid(Class<?> type,long initial,long delay,Consumer<String> callback)throws Exception{
        try(Fixture f=new Fixture(type,initial,delay,callback)){throw new AssertionError("Invalid retry constructor accepted: initial="+initial+", delay="+delay+", callback="+(callback==null?"null":"configured"));}
        catch(InvocationTargetException error){
            require(causedBy(error,IllegalArgumentException.class)||causedBy(error,NullPointerException.class),"Wrong configuration failure");
        }
    }
    static void verifyFailureIsolation(Class<?> type)throws Exception{
        AtomicInteger attempts=new AtomicInteger(),otherAttempts=new AtomicInteger();
        AtomicBoolean wrongOrder=new AtomicBoolean(),callerExecution=new AtomicBoolean();
        CountDownLatch recovered=new CountDownLatch(3),otherRecovered=new CountDownLatch(2);
        Thread caller=Thread.currentThread();
        try(Fixture f=new Fixture(type,0,30,order->{
            if(Thread.currentThread()==caller)callerExecution.set(true);
            if(order.equals("failing-order")){
                int attempt=attempts.incrementAndGet();
                if(attempt==1)throw new IllegalArgumentException("injected payment retry failure");
                recovered.countDown();
            }else if(order.equals("other-order")){otherAttempts.incrementAndGet();otherRecovered.countDown();}
            else wrongOrder.set(true);
        })){
            f.send("failing-order");f.send("other-order");
            require(recovered.await(2,TimeUnit.SECONDS),"Retry callback did not recover for later periods after its first failure");
            require(otherRecovered.await(1,TimeUnit.SECONDS),"One order failure stopped another order retry");
            require(!wrongOrder.get()&&!callerExecution.get(),"Retry changed order id or ran downstream inline");
            f.stop();require(f.pool.isTerminated(),"stop returned before retry scheduler terminated");
            int stopped=attempts.get()+otherAttempts.get();Thread.sleep(100);
            require(attempts.get()+otherAttempts.get()==stopped,"Retry callback continued after stop");
            try{f.send("closed-order");throw new AssertionError("Closed scheduler accepted a retry");}
            catch(InvocationTargetException error){require(causedBy(error,RejectedExecutionException.class),"Closed scheduler did not reject synchronously");}
            Field pending=type.getDeclaredField("pendingRetries");pending.setAccessible(true);
            require(pending.get(f.service)instanceof Queue<?> q&&q.contains("closed-order"),"Rejected order missing from compensation queue");
            f.stop();
        }
    }
    static void verifyFixedDelay(Class<?> type)throws Exception{
        AtomicInteger attempts=new AtomicInteger(),active=new AtomicInteger(),maxActive=new AtomicInteger();
        AtomicLong ended=new AtomicLong(),gap=new AtomicLong(Long.MAX_VALUE);
        CountDownLatch first=new CountDownLatch(1),release=new CountDownLatch(1),next=new CountDownLatch(1);
        try(Fixture f=new Fixture(type,40,120,order->{
            int current=active.incrementAndGet();maxActive.accumulateAndGet(current,Math::max);
            try{
                if(attempts.incrementAndGet()==1){
                    first.countDown();
                    try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}
                    ended.set(System.nanoTime());
                }else{gap.compareAndSet(Long.MAX_VALUE,System.nanoTime()-ended.get());next.countDown();}
            }finally{active.decrementAndGet();}
        })){
            try{
                long started=System.nanoTime();f.send("delayed-order");
                require(first.await(1,TimeUnit.SECONDS),"Initial delayed retry never executed");
                require(System.nanoTime()-started>=TimeUnit.MILLISECONDS.toNanos(20),"Initial retry delay ignored");
                // Longer than the period: fixed-rate scheduling would try to catch up immediately.
                Thread.sleep(200);release.countDown();
                require(next.await(1,TimeUnit.SECONDS),"Retry was scheduled only once instead of periodically");
                require(gap.get()>=TimeUnit.MILLISECONDS.toNanos(80),"Retry used fixed rate or ignored delay after completion");
                require(maxActive.get()==1,"Same retry registration overlapped itself");f.stop();
            }finally{release.countDown();}
        }
    }
    static void verifyPendingShutdown(Class<?> type)throws Exception{
        AtomicInteger calls=new AtomicInteger();
        try(Fixture f=new Fixture(type,3000,30,order->calls.incrementAndGet())){
            f.send("not-started");
            ExecutorService closer=Executors.newSingleThreadExecutor();
            try{
                Future<?> closed=closer.submit(()->{try{f.stop();}catch(Exception e){throw new RuntimeException(e);}});
                try{closed.get(1,TimeUnit.SECONDS);}catch(TimeoutException error){throw new AssertionError("Shutdown waited for an unstarted delayed retry",error);}
                require(f.pool.isTerminated(),"Delayed retry scheduler still alive after stop");
                require(calls.get()==0,"Shutdown invoked an unstarted retry callback");
            }finally{closer.shutdownNow();}
        }
    }
    static void verifyRunningShutdown(Class<?> type)throws Exception{
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),exited=new CountDownLatch(1);
        AtomicBoolean interrupted=new AtomicBoolean();
        try(Fixture f=new Fixture(type,0,30,order->{
            entered.countDown();try{release.await();}
            catch(InterruptedException error){interrupted.set(true);Thread.currentThread().interrupt();}
            finally{exited.countDown();}
        })){
            ExecutorService closers=Executors.newFixedThreadPool(2);
            try{
                f.send("running");require(entered.await(1,TimeUnit.SECONDS),"Running retry never started");
                Future<?> first=closers.submit(()->{try{f.stop();}catch(Exception e){throw new RuntimeException(e);}});
                try{first.get(20,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned while retry was running");}catch(TimeoutException expected){}
                Future<?> second=closers.submit(()->{try{f.stop();}catch(Exception e){throw new RuntimeException(e);}});
                try{second.get(20,TimeUnit.MILLISECONDS);throw new AssertionError("Repeated stop returned while retry was running");}catch(TimeoutException expected){}
                first.get(1,TimeUnit.SECONDS);second.get(1,TimeUnit.SECONDS);
                require(exited.getCount()==0&&interrupted.get(),"Forced stop did not stop the interruptible retry");
                require(f.pool.isTerminated(),"Forced stop returned before termination");
            }finally{release.countDown();closers.shutdownNow();}
        }
    }
    static void verifyInterruptedShutdown(Class<?> type)throws Exception{
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        try(Fixture f=new Fixture(type,0,30,order->{
            entered.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}
        })){
            try{
                f.send("interrupted-stop");require(entered.await(1,TimeUnit.SECONDS),"Interrupted shutdown target never started");
                Thread.currentThread().interrupt();
                try{f.stop();}catch(InvocationTargetException error){require(causedBy(error,InterruptedException.class),"Interrupted stop lost its cause");}
                require(Thread.currentThread().isInterrupted(),"Shutdown swallowed caller interrupt");
                Thread.interrupted();require(f.pool.awaitTermination(1,TimeUnit.SECONDS),"Interrupted shutdown left retry work running");
            }finally{Thread.interrupted();release.countDown();}
        }
    }
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0]);
        if(args.length>1){
            require(args.length==2,"Expected one retry acceptance scenario");
            switch(args[1]){
                case "failure-isolation" -> verifyFailureIsolation(type);
                case "fixed-delay" -> verifyFixedDelay(type);
                case "pending-shutdown" -> verifyPendingShutdown(type);
                case "running-shutdown" -> verifyRunningShutdown(type);
                case "interrupted-shutdown" -> verifyInterruptedShutdown(type);
                default -> throw new AssertionError("Unknown retry acceptance scenario");
            }
            return;
        }
        rejectsInvalid(type,-1,30,order->{});rejectsInvalid(type,0,0,order->{});rejectsInvalid(type,0,30,null);
        Object defaults=type.getConstructor().newInstance();
        try{
            try{type.getMethod("scheduleRetry",String.class).invoke(defaults,"unconfigured");throw new AssertionError("Unconfigured downstream silently accepted retry");}
            catch(InvocationTargetException error){require(causedBy(error,IllegalStateException.class),"Missing callback did not fail clearly");}
        }finally{type.getMethod("stop").invoke(defaults);}
        verifyFailureIsolation(type);verifyFixedDelay(type);verifyPendingShutdown(type);verifyRunningShutdown(type);verifyInterruptedShutdown(type);
    }
}
