import java.lang.reflect.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

/** Post-run check of the actual closing thread's interrupt flag and drain behavior. */
class InterruptProbe {
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0]);
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        Consumer<String> downstream=value->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}};
        Object service=type.getConstructor(Consumer.class).newInstance(downstream);
        ThreadPoolExecutor pool=null;
        for(Field field:type.getDeclaredFields()){field.setAccessible(true);if(field.get(service)instanceof ThreadPoolExecutor p)pool=p;}
        if(pool==null)throw new AssertionError("No testable pool");
        AtomicReference<Throwable> error=new AtomicReference<>();AtomicBoolean restored=new AtomicBoolean();
        Thread closer=new Thread(()->{try{
            Thread.currentThread().interrupt();type.getMethod("stop").invoke(service);restored.set(Thread.currentThread().isInterrupted());
        }catch(Throwable failure){error.set(failure);}},"interrupt-probe-closer");
        try{
            type.getMethod("publish",String.class).invoke(service,"block");
            if(!entered.await(1,TimeUnit.SECONDS))throw new AssertionError("Callback not started");
            closer.start();closer.join(30);
            if(!closer.isAlive())throw new AssertionError("stop failed or returned before callback drain",error.get());
            release.countDown();closer.join(1000);
            if(closer.isAlive()||error.get()!=null||!restored.get()||!pool.isTerminated())throw new AssertionError("Interrupt restoration/drain failed",error.get());
        }finally{release.countDown();pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);closer.join(1000);}
    }
}
