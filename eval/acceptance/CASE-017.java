import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

/** Real callback behavior, not merely identity of an unrelated executor. */
class AcceptanceTest {
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void send(Object service, String id) throws Exception {
        try { service.getClass().getMethod("notify", String.class).invoke(service,id); }
        catch (InvocationTargetException error) {
            if (error.getCause() instanceof RejectedExecutionException rejection) throw rejection;
            throw error;
        }
    }
    static Map<?,?> stats(Object service) throws Exception {
        Object result=service.getClass().getMethod("stats").invoke(service);
        require(result instanceof Map<?,?>,"stats() must expose numeric active/completed/failed/rejected counters");
        return (Map<?,?>)result;
    }
    static long metric(Object service,String key) throws Exception {
        Object value=stats(service).get(key);
        require(value instanceof Number,"Missing numeric metric "+key);
        return ((Number)value).longValue();
    }
    static void idle(Object service) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(metric(service,"active")!=0 && System.nanoTime()<end) Thread.sleep(2);
        require(metric(service,"active")==0,"Admission permit or active count leaked");
    }
    public static void main(String[] args) throws Exception {
        Class<?> type=Class.forName(args[0]);
        var constructor=type.getConstructor(int.class,Consumer.class);
        CountDownLatch occupied=new CountDownLatch(2), release=new CountDownLatch(1);
        AtomicInteger active=new AtomicInteger(),peak=new AtomicInteger(), completed=new AtomicInteger();
        AtomicBoolean virtual=new AtomicBoolean(true);
        AtomicBoolean interruptedObserved=new AtomicBoolean();
        Map<String,Thread> workers=new ConcurrentHashMap<>();
        Set<String> observed=ConcurrentHashMap.newKeySet();
        Consumer<String> downstream=id -> {
            virtual.compareAndSet(true,Thread.currentThread().isVirtual());
            observed.add(id);
            workers.put(id,Thread.currentThread());
            int running=active.incrementAndGet(); peak.accumulateAndGet(running,Math::max);
            try {
                if(id.startsWith("hold")) {
                    occupied.countDown();
                    try { release.await(); } catch(InterruptedException error) { interruptedObserved.set(true); Thread.currentThread().interrupt(); }
                }
                if(id.startsWith("failure")) throw new IllegalStateException("injected downstream failure");
                completed.incrementAndGet();
            } finally { active.decrementAndGet(); }
        };
        Object service=constructor.newInstance(2,downstream);
        try {
            // Submission itself must return while downstream is blocked.
            ExecutorService submitter=Executors.newSingleThreadExecutor();
            try {
                submitter.submit(()->{try{send(service,"hold-1");send(service,"hold-2");}catch(Exception e){throw new RuntimeException(e);}}).get(1,TimeUnit.SECONDS);
            } finally {submitter.shutdownNow();}
            require(occupied.await(1,TimeUnit.SECONDS),"Downstream callbacks never executed");
            require(metric(service,"active")==2,"Active metric does not reflect occupied downstream calls");
            // Concurrent overload must reject before it creates unbounded waiting work.
            AtomicInteger rejections=new AtomicInteger();
            List<Throwable> errors=Collections.synchronizedList(new ArrayList<>());
            List<Thread> callers=new ArrayList<>();
            for(int i=0;i<24;i++) {
                final int n=i;
                Thread caller=new Thread(()->{
                    try {send(service,"overflow-"+n);errors.add(new AssertionError("Saturated notification silently accepted"));}
                    catch(RejectedExecutionException expected){rejections.incrementAndGet();}
                    catch(Throwable error){errors.add(error);}
                });
                callers.add(caller); caller.start();
            }
            for(Thread caller:callers){caller.join(1000);require(!caller.isAlive(),"Overload blocked caller");}
            require(errors.isEmpty(),"Overload admission errors: "+errors);
            require(rejections.get()==24,"Overload did not explicitly reject every saturated request");
            require(metric(service,"rejected")==24,"Rejections not counted exactly once");
            require(peak.get()==2,"Downstream concurrency exceeded configured limit");
            workers.get("hold-1").interrupt();
            release.countDown(); idle(service);
            require(interruptedObserved.get(),"Worker interruption was not exercised");
            require(completed.get()==2,"Accepted notifications not delivered exactly once");
            // A normal completion and repeated failures must all return their permits.
            for(int i=0;i<5;i++){send(service,"failure-"+i);idle(service);}
            send(service,"after-failures");idle(service);
            require(observed.contains("after-failures"),"Exceptions exhausted downstream permits");
            require(metric(service,"failed")==5,"Downstream failures not observable");
            require(metric(service,"completed")==3,"Completed metric includes rejected/failed calls");
            require(observed.stream().noneMatch(id->id.startsWith("overflow")),"Rejected work ran later");
            require(virtual.get(),"Actual downstream callback ran on a platform/caller thread");
            type.getMethod("stop").invoke(service);
            boolean rejected=false;
            try{send(service,"after-stop");}catch(RejectedExecutionException expected){rejected=true;}
            require(rejected,"Stopped notifier accepted work");
            require(metric(service,"active")==0,"Stopped notifier retained active work");
        } finally {release.countDown();type.getMethod("stop").invoke(service);}
        // Caller interruption must not accidentally bypass admission or run downstream on caller.
        AtomicBoolean ran=new AtomicBoolean();
        Object interrupted=constructor.newInstance(1,(Consumer<String>)id->{require(Thread.currentThread().isVirtual(),"Interrupted caller fallback ran downstream");ran.set(true);});
        try {
            Thread.currentThread().interrupt();
            send(interrupted,"interrupted-caller");
            require(Thread.currentThread().isInterrupted(),"notify swallowed caller interruption");
        } finally {Thread.interrupted();type.getMethod("stop").invoke(interrupted);}
        require(ran.get(),"Interrupted caller lost accepted notification");
        CountDownLatch drainingStarted=new CountDownLatch(1), drainingRelease=new CountDownLatch(1);
        Object draining=constructor.newInstance(1,(Consumer<String>)id->{
            drainingStarted.countDown();
            try{drainingRelease.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}
        });
        ExecutorService closer=Executors.newFixedThreadPool(2);
        try {
            send(draining,"drain"); require(drainingStarted.await(1,TimeUnit.SECONDS),"Drain callback never started");
            Future<?> closing=closer.submit(()->{try{type.getMethod("stop").invoke(draining);}catch(Exception error){throw new RuntimeException(error);}});
            try {closing.get(100,TimeUnit.MILLISECONDS);throw new AssertionError("stop returned before accepted downstream finished");}
            catch(TimeoutException expected) { /* stop must still be draining */ }
            Future<?> repeated=closer.submit(()->{try{type.getMethod("stop").invoke(draining);}catch(Exception error){throw new RuntimeException(error);}});
            try {repeated.get(100,TimeUnit.MILLISECONDS);throw new AssertionError("Repeated stop returned before accepted downstream finished");}
            catch(TimeoutException expected) { /* every stop caller must observe completion */ }
            drainingRelease.countDown(); closing.get(2,TimeUnit.SECONDS); repeated.get(2,TimeUnit.SECONDS);
        } finally {drainingRelease.countDown();closer.shutdownNow();type.getMethod("stop").invoke(draining);}
    }
}
