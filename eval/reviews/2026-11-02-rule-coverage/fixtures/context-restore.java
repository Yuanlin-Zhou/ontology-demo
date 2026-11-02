import java.util.*;import java.util.concurrent.*;
class A {ThreadLocal<String> T=new ThreadLocal<>();void f(){String previous=T.get();T.set("new");try{}finally{T.set(previous);}}}
