import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

/** Draft behavior contracts for domain review; no knowledge-label gold is embedded here. */
class AcceptanceTest {
    static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    static Throwable cause(Throwable error){while((error instanceof InvocationTargetException||error instanceof ExecutionException)&&error.getCause()!=null)error=error.getCause();return error;}
    static ThreadPoolExecutor pool(Object object)throws Exception{
        ThreadPoolExecutor result=null;
        for(Field f:object.getClass().getDeclaredFields()){f.setAccessible(true);if(f.get(object)instanceof ThreadPoolExecutor p&&!(p instanceof ScheduledThreadPoolExecutor)){require(result==null,"Multiple business pools require review adapter");result=p;}}
        require(result!=null,"No observable business pool");return result;
    }
    static void cleanup(Object object)throws Exception{
        for(Field f:object.getClass().getDeclaredFields()){f.setAccessible(true);if(f.get(object)instanceof ExecutorService executor){executor.shutdownNow();executor.awaitTermination(1,TimeUnit.SECONDS);}}
    }
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0],false,AcceptanceTest.class.getClassLoader());
        switch(args[1]){case "REVIEW-CAPACITY"->capacity(type);case "REVIEW-TENANT"->tenant(type);case "REVIEW-FAILURE"->failure(type);default->throw new AssertionError("Unknown review candidate");}
    }
    static void capacity(Class<?> type)throws Exception{
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);Set<String> seen=ConcurrentHashMap.newKeySet();AtomicReference<Throwable> wrongThread=new AtomicReference<>();
        Consumer<String> callback=id->{
            if(Thread.currentThread().getName().equals("candidate-caller")){wrongThread.set(new AssertionError("Business work ran on caller"));return;}
            seen.add(id);entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}
        };
        Object service=type.getConstructor(Consumer.class).newInstance(callback);ExecutorService caller=Executors.newSingleThreadExecutor(r->new Thread(r,"candidate-caller"));
        try{
            ThreadPoolExecutor pool=pool(service);int maximum=pool.getMaximumPoolSize(),core=pool.getCorePoolSize();
            require(core>=1&&core<=maximum&&maximum<=2,"Downstream concurrency cap exceeded");
            long capacity=(long)pool.getQueue().size()+pool.getQueue().remainingCapacity();
            require(capacity>=4&&capacity<=4L*1024/256,"Queue violates minimum buffering or memory budget");
            Method send=type.getMethod("export",String.class);Set<String> accepted=new HashSet<>();boolean rejected=false;
            for(int i=0;i<capacity+maximum+2;i++){
                final String id="job-"+i;
                Throwable error=caller.submit(()->{try{send.invoke(service,id);return (Throwable)null;}catch(Throwable e){return cause(e);}}).get(500,TimeUnit.MILLISECONDS);
                require(wrongThread.get()==null,"Caller-runs fallback is forbidden");
                if(error==null)accepted.add(id);else{require(error instanceof RejectedExecutionException,"Unexpected overload failure");rejected=true;break;}
                if(i==0)require(entered.await(1,TimeUnit.SECONDS),"No actual callback");
            }
            require(rejected,"Saturation did not reject");require(pool.getLargestPoolSize()<=2,"Runtime concurrency exceeds cap");
            ExecutorService closer=Executors.newSingleThreadExecutor();
            try{
                Future<?> stopping=closer.submit(()->{try{type.getMethod("stop").invoke(service);}catch(Exception e){throw new RuntimeException(e);}});
                try{stopping.get(30,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned before accepted work drained");}catch(TimeoutException expected){}
                release.countDown();stopping.get(2,TimeUnit.SECONDS);require(pool.isTerminated(),"Pool not terminated");
                require(seen.equals(accepted),"Accepted work was lost or rejected work executed");
            }finally{closer.shutdownNow();}
        }finally{release.countDown();caller.shutdownNow();cleanup(service);}
    }
    @SuppressWarnings("unchecked") static void tenant(Class<?> type)throws Exception{
        require(Class.forName("TenantProcessor").isAssignableFrom(type),"Existing interface contract removed");
        ThreadLocal<String> context=(ThreadLocal<String>)type.getField("TENANT").get(null);
        Function<String,String> callback=id->{require("tenant-new".equals(context.get()),"Worker sees wrong tenant");if(id.equals("fail"))throw new IllegalStateException("tenant-callback-sentinel");return "processed-"+id;};
        Object service=type.getConstructor(Function.class).newInstance(callback);ThreadPoolExecutor pool=pool(service);Method method=type.getMethod("process",String.class,String.class);
        try{
            require(pool.getCorePoolSize()==1&&pool.getMaximumPoolSize()==1&&pool.getQueue().remainingCapacity()==8,"Unrelated worker configuration changed");
            for(boolean workerEmpty:new boolean[]{false,true})for(boolean callerEmpty:new boolean[]{false,true}){
                pool.submit(()->{if(workerEmpty)context.remove();else context.set("worker-before");}).get(1,TimeUnit.SECONDS);
                if(callerEmpty)context.remove();else context.set("caller-before");
                require("tenant-new:processed-ok".equals(method.invoke(service,"tenant-new","ok")),"Business result changed");
                require(Objects.equals(callerEmpty?null:"caller-before",context.get()),"Caller context leaked");
                require(Objects.equals(workerEmpty?null:"worker-before",pool.submit(context::get).get(1,TimeUnit.SECONDS)),"Worker context leaked");
                try{method.invoke(service,"tenant-new","fail");throw new AssertionError("Callback failure hidden");}catch(InvocationTargetException error){require(cause(error)instanceof IllegalStateException&&cause(error).getMessage().contains("tenant-callback-sentinel"),"Original failure cause lost");}
                require(Objects.equals(callerEmpty?null:"caller-before",context.get()),"Caller context leaked on failure");
                require(Objects.equals(workerEmpty?null:"worker-before",pool.submit(context::get).get(1,TimeUnit.SECONDS)),"Worker context leaked on failure");
            }
            CountDownLatch audit=new CountDownLatch(1);type.getMethod("scheduleAudit",Runnable.class).invoke(service,(Runnable)audit::countDown);require(audit.await(2,TimeUnit.SECONDS),"Unrelated audit scheduling changed");
            type.getMethod("stop").invoke(service);
        }finally{context.remove();cleanup(service);}
    }
    static void failure(Class<?> type)throws Exception{
        PrintStream oldError=System.err,oldOutput=System.out;ByteArrayOutputStream captured=new ByteArrayOutputStream();Object service=null;
        Set<String> seen=ConcurrentHashMap.newKeySet();AtomicReference<Throwable> callbackError=new AtomicReference<>();
        try(PrintStream stream=new PrintStream(captured)){
            System.setErr(stream);System.setOut(stream);
            Consumer<String> callback=id->{
                if(!Thread.currentThread().getName().startsWith("delivery-worker")){callbackError.set(new AssertionError("Worker name/thread changed"));return;}
                seen.add(id);if(id.equals("fail"))throw new IllegalStateException("candidate-failure-sentinel");
            };
            service=type.getConstructor(Consumer.class).newInstance(callback);ThreadPoolExecutor pool=pool(service);
            require(pool.getCorePoolSize()==1&&pool.getMaximumPoolSize()==1&&pool.getQueue().remainingCapacity()==8,"Unrelated capacity changed");
            Method deliver=type.getMethod("deliver",String.class);deliver.invoke(service,"fail");deliver.invoke(service,"after");pool.submit(()->{}).get(1,TimeUnit.SECONDS);stream.flush();
            require(callbackError.get()==null,"Callback not on expected business worker");require(seen.containsAll(List.of("fail","after")),"Exception blocked later delivery");
            require(captured.toString().contains("candidate-failure-sentinel"),"Original failure cause was not recorded");
            type.getMethod("stop").invoke(service);
            try{deliver.invoke(service,"closed");throw new AssertionError("Closed service accepted delivery");}catch(InvocationTargetException e){require(cause(e)instanceof RejectedExecutionException,"Rejection propagation changed");}
        }finally{System.setErr(oldError);System.setOut(oldOutput);if(service!=null)cleanup(service);}
    }
}
