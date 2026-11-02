import java.util.*;import java.util.concurrent.*;
class A {void f(ExecutorService p){List<Runnable> pending=p.shutdownNow();}}
