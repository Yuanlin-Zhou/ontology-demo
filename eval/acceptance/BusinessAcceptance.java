import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

/** v2 only. Observe actual injected business effects, not executor task counts alone. */
class BusinessAcceptance {
    static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    static Throwable cause(Throwable error){while(error instanceof InvocationTargetException&&error.getCause()!=null)error=error.getCause();return error;}
    static class Fixture implements AutoCloseable {
        final String caseId;
        final Class<?> type;
        final Object service;
        final Method send;
        final ThreadPoolExecutor pool;
        final ThreadLocal<String> tenant;
        final LinkedBlockingQueue<String> observed=new LinkedBlockingQueue<>();
        final AtomicReference<Throwable> callbackAssertion=new AtomicReference<>();
        volatile CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        final Class<?> orderType;
        Fixture(Class<?> type,String caseId)throws Exception {
            this.type=type;this.caseId=caseId;
            boolean order=caseId.equals("CASE-001")||caseId.equals("CASE-002");
            orderType=order?Class.forName("com.example.order.domain.Order"):null;
            if(caseId.equals("CASE-002")){Field f=type.getDeclaredField("TENANT");f.setAccessible(true);tenant=(ThreadLocal<String>)f.get(null);}else tenant=null;
            Consumer<Object> callback=input->{
                try {
                    String id=order?(String)orderType.getMethod("id").invoke(input):(String)input;
                    require(!Thread.currentThread().getName().startsWith("business-api-caller"),"Callback ran on the submitting thread");
                    if(caseId.equals("CASE-010"))require(Thread.currentThread().getName().startsWith("file-process"),"Missing file-process worker name");
                    if(tenant!=null)require(("tenant-"+id).equals(tenant.get()),"Callback did not receive order tenant");
                    observed.add(id);
                    if(id.equals("block")){entered.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}}
                    if(id.equals("fail"))throw new IllegalStateException("Injected observable downstream failure");
                }catch(AssertionError error){callbackAssertion.set(error);throw error;}
                catch(ReflectiveOperationException error){callbackAssertion.set(error);throw new IllegalStateException(error);}
            };
            if(caseId.equals("CASE-002")){
                Function<String,Object> loader=id->{try{return orderType.getConstructor(String.class,String.class).newInstance(id,"loaded");}catch(Exception error){throw new IllegalStateException(error);}};
                service=type.getConstructor(Consumer.class,Function.class).newInstance(callback,loader);
            }else service=type.getConstructor(Consumer.class).newInstance(callback);
            String method=switch(caseId){case "CASE-001"->"notifyCreated";case "CASE-002"->"syncCreated";case "CASE-003"->"export";case "CASE-007"->"write";case "CASE-008"->"sync";case "CASE-010"->"process";case "CASE-011"->"onEvent";default->throw new AssertionError("Unknown observable contract");};
            send=type.getMethod(method,order?orderType:String.class);
            ThreadPoolExecutor found=null;
            for(Field field:type.getDeclaredFields()){field.setAccessible(true);if(field.get(service)instanceof ThreadPoolExecutor candidate){require(found==null,"Multiple business pools require an explicit adapter");found=candidate;}}
            require(found!=null,"No observable instance business pool");pool=found;
            pool.setCorePoolSize(1);pool.setMaximumPoolSize(1);
            if(tenant!=null)pool.submit(()->tenant.set("worker-before")).get(1,TimeUnit.SECONDS);
        }
        Object input(String id)throws Exception{return orderType==null?id:orderType.getConstructor(String.class,String.class).newInstance(id,"tenant-"+id);}
        Throwable call(String id)throws Exception {
            if(tenant!=null)tenant.set("caller-before");
            try {send.invoke(service,input(id));return null;}catch(InvocationTargetException error){return cause(error);}
            finally {if(tenant!=null)require("caller-before".equals(tenant.get()),"Submitting caller context changed");}
        }
        Throwable asyncCall(String id)throws Exception {
            ExecutorService caller=Executors.newSingleThreadExecutor(r->new Thread(r,"business-api-caller"));
            try {return caller.submit(()->call(id)).get(1,TimeUnit.SECONDS);}
            finally {caller.shutdownNow();}
        }
        long metric(String name)throws Exception {
            Object value=type.getMethod("stats").invoke(service);
            require(value instanceof Map<?,?>,"stats must expose actual counters as Map");
            Object count=((Map<?,?>)value).get(name);require(count instanceof Long,"Missing Long metric "+name);return (Long)count;
        }
        void drain()throws Exception {
            pool.submit(()->{}).get(2,TimeUnit.SECONDS);
            if(callbackAssertion.get()!=null)throw new AssertionError("Callback contract assertion failed",callbackAssertion.get());
            if(tenant!=null)require("worker-before".equals(pool.submit(tenant::get).get(1,TimeUnit.SECONDS)),"Worker tenant context leaked");
        }
        void next(String id)throws Exception{require(id.equals(observed.poll(1,TimeUnit.SECONDS)),"No actual callback effect for "+id);}
        void stop()throws Exception{type.getMethod("stop").invoke(service);}
        public void close()throws Exception {release.countDown();pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);if(tenant!=null)tenant.remove();}
    }
    public static void main(String[] args)throws Exception {
        Class<?> type=Class.forName(args[0]);String id=args[1];
        // Missing v2 constructors are a contract mismatch, not a historical v1 business verdict.
        try(Fixture f=new Fixture(type,id)){
            require(f.asyncCall("block")==null,"Initial submission failed");
            require(f.entered.await(1,TimeUnit.SECONDS),"Real callback never started");f.next("block");
            require(f.asyncCall("queued")==null,"Second submission failed");
            require(f.observed.poll(30,TimeUnit.MILLISECONDS)==null,"Callback bypassed blocked business worker");
            require(f.pool.getQueue().size()==1,"Actual business work was not queued");
            f.release.countDown();f.next("queued");f.drain();
            require(f.metric("submitted")==2&&f.metric("completed")==2&&f.metric("failed")==0,"Successful callback counters do not match effects");
            require(f.asyncCall("fail")==null,"Async failure escaped into submitting caller");f.next("fail");f.drain();
            require(f.metric("failed")==1,"Actual callback failure was not observable");
            require(f.asyncCall("after")==null,"Failure blocked later delivery");f.next("after");f.drain();
            require(f.metric("submitted")==4&&f.metric("completed")==3,"Counters do not track real consecutive effects");
            if(id.equals("CASE-002")){
                Object loaded=type.getMethod("reload",String.class).invoke(f.service,"load");
                require("load".equals(f.orderType.getMethod("id").invoke(loaded))&&"loaded".equals(f.orderType.getMethod("tenantId").invoke(loaded)),"reload did not use injected loader result");
            }
            f.entered=new CountDownLatch(1);f.release=new CountDownLatch(1);
            require(f.asyncCall("block")==null,"Saturation setup failed");require(f.entered.await(1,TimeUnit.SECONDS),"Saturation callback not running");f.next("block");
            int capacity=f.pool.getQueue().remainingCapacity();require(capacity>0&&capacity<=10000,"Unbounded observable business queue");
            for(int i=0;i<capacity;i++)require(f.asyncCall("fill-"+i)==null,"Premature rejection");
            long before=f.metric("rejected");require(f.asyncCall("overflow")instanceof RejectedExecutionException,"Saturation did not reject synchronously");
            require(f.metric("rejected")==before+1,"Rejection counted zero or multiple times");
            if(id.equals("CASE-008")){Field q=type.getDeclaredField("retryQueue");q.setAccessible(true);require(q.get(f.service)instanceof Collection<?> values&&values.contains("overflow"),"Rejected SKU missing from compensation queue");}
            f.release.countDown();for(int i=0;i<capacity;i++)f.next("fill-"+i);f.drain();
            f.entered=new CountDownLatch(1);f.release=new CountDownLatch(1);
            require(f.asyncCall("block")==null,"Drain setup failed");require(f.entered.await(1,TimeUnit.SECONDS),"Drain callback not running");f.next("block");
            ExecutorService closer=Executors.newSingleThreadExecutor();
            try {
                Future<?> stopping=closer.submit(()->{try{f.stop();}catch(Exception error){throw new RuntimeException(error);}});
                try{stopping.get(30,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned before accepted callback finished");}catch(TimeoutException expected){}
                f.release.countDown();stopping.get(1,TimeUnit.SECONDS);require(f.pool.isTerminated(),"Business pool not terminated");
            }finally{f.release.countDown();closer.shutdownNow();}
            require(f.asyncCall("closed")instanceof RejectedExecutionException,"Closed service accepted work");
        }
        Object unconfigured=type.getConstructor().newInstance();
        try {
            try(Fixture configured=new Fixture(type,id)){
                try{configured.send.invoke(unconfigured,configured.input("default"));throw new AssertionError("Unconfigured service pretended to deliver");}
                catch(InvocationTargetException error){require(cause(error)instanceof IllegalStateException,"Unconfigured downstream must fail explicitly");}
            }
        }finally{type.getMethod("stop").invoke(unconfigured);}
        // The public configured constructor must not silently treat a null callback as a default.
        try {
            if(id.equals("CASE-002"))type.getConstructor(Consumer.class,Function.class).newInstance(null,(Function<String,Object>)x->null);
            else type.getConstructor(Consumer.class).newInstance((Object)null);
            throw new AssertionError("Configured constructor accepted null callback");
        }catch(InvocationTargetException error){require(cause(error)instanceof NullPointerException||cause(error)instanceof IllegalArgumentException,"Wrong null callback failure");}
    }
}
