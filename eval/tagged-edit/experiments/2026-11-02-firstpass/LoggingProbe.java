import java.io.*;
import java.lang.reflect.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Post-run diagnostic of the original task's explicit failure-recording requirement. */
class LoggingProbe {
    public static void main(String[] args)throws Exception{
        Class<?> type=Class.forName(args[0]);
        Consumer<String> downstream=value->{throw new IllegalStateException("logging-probe-sentinel");};
        Object service=type.getConstructor(Consumer.class).newInstance(downstream);
        ThreadPoolExecutor pool=null;
        for(Field field:type.getDeclaredFields()){field.setAccessible(true);if(field.get(service)instanceof ThreadPoolExecutor p)pool=p;}
        if(pool==null)throw new AssertionError("No testable pool");
        PrintStream old=System.err;ByteArrayOutputStream captured=new ByteArrayOutputStream();
        try(PrintStream stream=new PrintStream(captured)){
            System.setErr(stream);
            type.getMethod("publish",String.class).invoke(service,"fail");
            pool.submit(()->{}).get(1,TimeUnit.SECONDS);
            stream.flush();
            if(!captured.toString().contains("logging-probe-sentinel"))throw new AssertionError("Callback failure was swallowed without a failure record");
        }finally{System.setErr(old);pool.shutdownNow();pool.awaitTermination(1,TimeUnit.SECONDS);}
    }
}
