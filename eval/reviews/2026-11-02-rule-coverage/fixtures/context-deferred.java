import java.util.*;import java.util.concurrent.*;
class A {ThreadLocal<String> T=new ThreadLocal<>();void f(){T.set("new");try{}finally{Runnable later=()->T.remove();}}}
