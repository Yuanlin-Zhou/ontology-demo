import java.util.function.Consumer;
public class InterruptProbe {
 public static void main(String[] args) throws Exception {
  Class<?> type=Class.forName(args[0]);
  Object service=type.getConstructor(int.class,Consumer.class).newInstance(1,(Consumer<String>)id->{});
  try {
   Thread.currentThread().interrupt();
   type.getMethod("stop").invoke(service);
   if(!Thread.currentThread().isInterrupted())throw new AssertionError("stop lost current-thread interruption");
   System.out.println("PASS: stop restores interruption through loop/finally");
  } finally {Thread.interrupted();type.getMethod("stop").invoke(service);}
 }
}
