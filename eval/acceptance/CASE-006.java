import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Exercises the scoped CASE-006 business contract, through public dispatch and real workers. */
class AcceptanceTest {
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static class Fixture implements AutoCloseable {
        final List<String> completed = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        final Object service;
        final ThreadPoolExecutor pool;
        final Method dispatch;
        Fixture(Class<?> type) throws Exception {
            Consumer<String> handler = id -> {
                if (id.equals("block")) {
                    started.countDown();
                    try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                } else if (id.equals("throw")) { throw new IllegalStateException("task failure"); }
                else { completed.add(id); }
            };
            service = type.getConstructor(Consumer.class).newInstance(handler);
            dispatch = type.getMethod("dispatch", String.class, int.class);
            ThreadPoolExecutor found = null;
            for (Field field : type.getDeclaredFields()) {
                field.setAccessible(true);
                if (field.get(service) instanceof ThreadPoolExecutor executor) found = executor;
            }
            require(found != null, "No observable ThreadPoolExecutor field");
            pool = found;
            // Only waiting work is ordered. One worker makes observable execution order deterministic.
            pool.setCorePoolSize(1); pool.setMaximumPoolSize(1);
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (pool.getPoolSize() > 1 && System.nanoTime() < end) Thread.sleep(1);
            send("block", Integer.MAX_VALUE);
            require(started.await(1, TimeUnit.SECONDS), "Handler never ran asynchronously");
        }
        void send(String id, int priority) throws Exception {
            try { dispatch.invoke(service, id, priority); }
            catch (InvocationTargetException e) {
                if (e.getCause() instanceof RejectedExecutionException rejected) throw rejected;
                throw e;
            }
        }
        int capacity() {
            long capacity = (long) pool.getQueue().size() + pool.getQueue().remainingCapacity();
            require(capacity >= 2 && capacity <= 10000, "Priority queue must have a finite testable capacity (2..10000)");
            return (int) capacity;
        }
        void finish(int count) throws Exception {
            release.countDown();
            pool.shutdown();
            require(pool.awaitTermination(2, TimeUnit.SECONDS), "Accepted tasks did not finish");
            require(completed.size() == count, "Unexpected accepted-task count: " + completed);
        }
        public void close() throws Exception { release.countDown(); pool.shutdownNow(); pool.awaitTermination(1, TimeUnit.SECONDS); }
    }
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName(args[0]);
        try (Fixture f = new Fixture(type)) {
            f.send("low", -1);
            type.getMethod("dispatch", String.class).invoke(f.service, "default");
            f.send("high-first", Integer.MAX_VALUE);
            f.send("high-second", Integer.MAX_VALUE);
            f.finish(4);
            require(f.completed.equals(List.of("high-first", "high-second", "default", "low")), "Priority / same-priority FIFO / default priority lost: " + f.completed);
        }
        try (Fixture f = new Fixture(type)) {
            int capacity = f.capacity();
            // The oldest task is also most important. It must survive overload.
            f.send("important-oldest", 100);
            for (int i = 1; i < capacity; i++) f.send("low-" + i, -1);
            f.send("replacement", 0);
            require(f.pool.getQueue().size() == capacity, "Replacement broke queue bound");
            f.finish(capacity);
            require(f.completed.get(0).equals("important-oldest"), "Overload evicted highest priority");
            require(f.completed.get(1).equals("replacement"), "Replacement not ordered by priority");
            require(!f.completed.contains("low-1") && f.completed.contains("low-2"), "Did not evict oldest among lowest priority");
        }
        try (Fixture f = new Fixture(type)) {
            int capacity = f.capacity();
            for (int i = 0; i < capacity; i++) f.send("equal-" + i, 1);
            f.send("equal-new", 1);
            f.finish(capacity);
            require(f.completed.get(0).equals("equal-1") && f.completed.get(capacity - 1).equals("equal-new"), "Equal-priority overload must evict oldest and retain FIFO");
        }
        try (Fixture f = new Fixture(type)) {
            int capacity = f.capacity();
            for (int i = 0; i < capacity; i++) f.send("important-" + i, 10);
            boolean rejected = false;
            try { f.send("less-important", 0); } catch (RejectedExecutionException expected) { rejected = true; }
            require(rejected, "Lower priority overload must explicitly reject new task");
            f.finish(capacity);
            require(!f.completed.contains("less-important"), "Lower priority task displaced important work");
        }
        try (Fixture f = new Fixture(type)) {
            int capacity = f.capacity();
            f.send("protected", 100);
            for (int i = 1; i < capacity; i++) f.send("old-" + i, 0);
            List<Throwable> failures = Collections.synchronizedList(new ArrayList<>());
            List<Thread> callers = new ArrayList<>();
            for (int i = 0; i < 32; i++) {
                final int n = i;
                Thread caller = new Thread(() -> {
                    try {
                        f.send("concurrent-" + n, 1);
                        require(f.pool.getQueue().size() <= capacity, "Concurrent replacement exceeded queue capacity");
                    } catch (Throwable error) { failures.add(error); }
                });
                callers.add(caller); caller.start();
            }
            for (Thread caller : callers) { caller.join(1000); require(!caller.isAlive(), "Submission deadlocked"); }
            require(failures.isEmpty(), "Concurrent submissions failed: " + failures);
            f.finish(capacity);
            require(f.completed.get(0).equals("protected"), "Concurrent overflow lost protected task");
        }
        try (Fixture f = new Fixture(type)) {
            f.send("throw", 1); f.send("after-failure", 0);
            f.finish(1);
            require(f.completed.contains("after-failure"), "Task failure stopped subsequent dispatch");
            boolean rejected = false;
            try { f.send("after-shutdown", 1); } catch (RejectedExecutionException expected) { rejected = true; }
            require(rejected, "Dispatch after shutdown must explicitly reject");
        }
        productionOverload(type);
    }
    /** Keep production sizing: extra non-core workers must not bypass overload rejection. */
    static void productionOverload(Class<?> type) throws Exception {
        CountDownLatch release=new CountDownLatch(1);
        List<String> completed=Collections.synchronizedList(new ArrayList<>());
        Consumer<String> handler=id -> {
            if (id.startsWith("block-")) {
                try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            } else completed.add(id);
        };
        Object service=type.getConstructor(Consumer.class).newInstance(handler);
        ThreadPoolExecutor pool=null;
        for(Field field:type.getDeclaredFields()) {
            field.setAccessible(true);
            if(field.get(service) instanceof ThreadPoolExecutor found) pool=found;
        }
        require(pool!=null,"No production executor");
        try {
            int core=pool.getCorePoolSize();
            require(core>0 && core<=32,"Expected bounded positive production worker count");
            Method send=type.getMethod("dispatch",String.class,int.class);
            for(int i=0;i<core;i++) send.invoke(service,"block-"+i,100);
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(1);
            while(pool.getActiveCount()<core && System.nanoTime()<end) Thread.sleep(1);
            require(pool.getActiveCount()==core,"Production workers never became occupied");
            int capacity=pool.getQueue().remainingCapacity();
            require(capacity>=4 && capacity<=10000,"Production priority queue must be bounded");
            for(int i=0;i<capacity;i++) send.invoke(service,"important-"+i,10);
            boolean rejected=false;
            try { send.invoke(service,"lower-priority-bypass",0); }
            catch(InvocationTargetException error) {
                if(error.getCause() instanceof RejectedExecutionException) rejected=true;
                else throw error;
            }
            require(rejected,"Production overload bypassed priority rejection by creating another worker");
            require(!completed.contains("lower-priority-bypass"),"Lower priority work bypassed important queue");
        } finally { release.countDown(); pool.shutdownNow(); pool.awaitTermination(1,TimeUnit.SECONDS); }
    }
}
