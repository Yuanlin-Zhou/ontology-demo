import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Independent edit behavior contract; all strategies receive the same public requirements. */
class AcceptanceTest {
    static void require(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    static Throwable root(Throwable error){while(error instanceof InvocationTargetException&&error.getCause()!=null)error=error.getCause();return error;}
    static ThreadPoolExecutor pool(Object service)throws Exception{
        ThreadPoolExecutor result=null;
        for(Field field:service.getClass().getDeclaredFields()){
            field.setAccessible(true);
            if(field.get(service)instanceof ThreadPoolExecutor p){require(result==null,"Multiple pools require a task-specific adapter");result=p;}
        }
        require(result!=null,"No observable instance business ThreadPoolExecutor");return result;
    }
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0]);String id=args[1];
        if(id.equals("EDIT-CONTEXT")){context(type);return;}
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        LinkedBlockingQueue<String> seen=new LinkedBlockingQueue<>();
        Consumer<String> callback=value->{
            require(!Thread.currentThread().getName().equals("edit-caller"),"Business callback ran synchronously on caller");
            seen.add(value);
            if(value.equals("fail"))throw new IllegalStateException("Injected downstream failure");
            if(value.equals("block")){entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}}
        };
        Object service=type.getConstructor(Consumer.class).newInstance(callback);
        ThreadPoolExecutor pool=null;ExecutorService caller=Executors.newSingleThreadExecutor(r->new Thread(r,"edit-caller"));
        try{
            pool=pool(service);require(pool.getCorePoolSize()==1&&pool.getMaximumPoolSize()==1,"Expected one business worker");
            Method send=type.getMethod(id.equals("EDIT-QUEUE")?"send":"publish",String.class);
            caller.submit(()->{try{send.invoke(service,"fail");}catch(Exception e){throw new RuntimeException(e);}}).get(500,TimeUnit.MILLISECONDS);
            send.invoke(service,"after");
            require("fail".equals(seen.poll(1,TimeUnit.SECONDS))&&"after".equals(seen.poll(1,TimeUnit.SECONDS)),"Failure blocked later callbacks");
            caller.submit(()->{try{send.invoke(service,"block");}catch(Exception e){throw new RuntimeException(e);}}).get(500,TimeUnit.MILLISECONDS);
            require(entered.await(1,TimeUnit.SECONDS),"Callback did not start");
            send.invoke(service,"q1");send.invoke(service,"q2");
            require(pool.getQueue().size()==2&&pool.getQueue().remainingCapacity()==0,"Queue must buffer exactly two tasks");
            try{send.invoke(service,"overflow");throw new AssertionError("Overload must reject synchronously");}
            catch(InvocationTargetException error){require(root(error)instanceof RejectedExecutionException,"Wrong rejection behavior");}
            ExecutorService closer=Executors.newSingleThreadExecutor();
            try{
                Future<?> stopped=closer.submit(()->{try{type.getMethod("stop").invoke(service);}catch(Exception e){throw new RuntimeException(e);}});
                try{stopped.get(30,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned before accepted work drained");}catch(TimeoutException expected){}
                release.countDown();stopped.get(2,TimeUnit.SECONDS);
                require(pool.isTerminated(),"stop did not terminate the pool");
                require(List.of("block","q1","q2").equals(List.of(seen.poll(1,TimeUnit.SECONDS),seen.poll(1,TimeUnit.SECONDS),seen.poll(1,TimeUnit.SECONDS))),"Missing or reordered business callbacks");
                try{send.invoke(service,"closed");throw new AssertionError("Closed service accepted work");}
                catch(InvocationTargetException error){require(root(error)instanceof RejectedExecutionException,"Wrong closed rejection");}
            }finally{closer.shutdownNow();}
        }finally{release.countDown();caller.shutdownNow();if(pool!=null){pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);}}
    }
    @SuppressWarnings("unchecked") static void context(Class<?> type)throws Exception{
        ThreadLocal<String> tenant=(ThreadLocal<String>)type.getField("TENANT").get(null);
        Function<String,String> callback=value->{
            require("tenant-new".equals(tenant.get()),"Wrong callback tenant");
            if(value.equals("fail"))throw new IllegalStateException("downstream failure");return "result-"+value;
        };
        Object service=type.getConstructor(Function.class).newInstance(callback);ThreadPoolExecutor pool=pool(service);
        Method run=type.getMethod("run",String.class,String.class);
        try{
            pool.submit(()->tenant.set("worker-before")).get(1,TimeUnit.SECONDS);
            tenant.set("caller-before");
            Object result=run.invoke(service,"tenant-new","ok");
            require("tenant-new:result-ok".equals(result),"Wrong business result");
            require("caller-before".equals(tenant.get()),"Caller context leaked on success");
            require("worker-before".equals(pool.submit(tenant::get).get(1,TimeUnit.SECONDS)),"Worker context leaked on success");
            try{run.invoke(service,"tenant-new","fail");throw new AssertionError("Downstream error hidden");}catch(InvocationTargetException expected){}
            require("caller-before".equals(tenant.get()),"Caller context leaked on failure");
            require("worker-before".equals(pool.submit(tenant::get).get(1,TimeUnit.SECONDS)),"Worker context leaked on failure");
            tenant.remove();
            run.invoke(service,"tenant-new","empty");require(tenant.get()==null,"Empty caller context not restored");
        }finally{tenant.remove();pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);}
    }
}
