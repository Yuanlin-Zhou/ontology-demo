import java.util.*;import java.util.concurrent.*;
class A {ThreadLocal<String> T=new ThreadLocal<>();void f(boolean c){T.set("new");try{}finally{if(c)T.remove();}}}
