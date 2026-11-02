import java.util.*;import java.util.concurrent.*;
class A {ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));void f()throws Exception{FutureTask<String> task=new FutureTask<>(()->"ok");Runnable queued=()->task.run();pool.execute(queued);try{task.get(1,TimeUnit.SECONDS);}catch(TimeoutException e){task.cancel(true);pool.remove(queued);}}}
