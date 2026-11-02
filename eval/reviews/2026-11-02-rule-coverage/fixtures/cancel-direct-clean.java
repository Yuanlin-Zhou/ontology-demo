import java.util.*;import java.util.concurrent.*;
class A {ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));void f()throws Exception{FutureTask<String> task=new FutureTask<>(()->"ok");pool.execute(task);try{task.get(1,TimeUnit.SECONDS);}catch(TimeoutException e){task.cancel(true);pool.remove(task);}}}
