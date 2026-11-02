import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Independent post-run diagnostic; confirms a loss scenario, not an acceptance pass. */
class ForcedQueueProbe {
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName(args[0]);
        String caseId = args[1];
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<String> delivered = new CopyOnWriteArrayList<>();
        Consumer<Object> callback = value -> {
            String id;
            try { id = value instanceof String ? (String)value : (String)value.getClass().getMethod("id").invoke(value); }
            catch (Exception error) { throw new RuntimeException(error); }
            delivered.add(id);
            if (id.equals("block")) {
                entered.countDown();
                try { release.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
        };
        Object service = type.getConstructor(Consumer.class).newInstance(callback);
        ThreadPoolExecutor pool = null;
        for (Field field : type.getDeclaredFields()) {
            field.setAccessible(true);
            if (field.get(service) instanceof ThreadPoolExecutor candidate) pool = candidate;
        }
        if (pool == null) throw new AssertionError("No business pool");
        pool.setCorePoolSize(1);
        pool.setMaximumPoolSize(1);
        boolean order = caseId.equals("CASE-001");
        Class<?> payload = order ? Class.forName("com.example.order.domain.Order") : String.class;
        String name = switch(caseId) {
            case "CASE-001" -> "notifyCreated";
            case "CASE-003" -> "export";
            case "CASE-007" -> "write";
            case "CASE-011" -> "onEvent";
            default -> throw new AssertionError("Unsupported probe case");
        };
        Method send = type.getMethod(name, payload);
        try {
            for (String id : List.of("block", "queued-a", "queued-b")) {
                Object value = order ? payload.getConstructor(String.class,String.class).newInstance(id,"tenant") : id;
                send.invoke(service, value);
                if (id.equals("block") && !entered.await(1,TimeUnit.SECONDS)) throw new AssertionError("Callback did not start");
            }
            if (pool.getQueue().size() != 2) throw new AssertionError("Probe did not queue two accepted tasks");
            type.getMethod("stop").invoke(service);
            Map<?,?> stats = (Map<?,?>)type.getMethod("stats").invoke(service);
            if (!pool.isTerminated() || !delivered.equals(List.of("block"))) throw new AssertionError("Expected forced shutdown loss was not observed");
            if (!Long.valueOf(3).equals(stats.get("submitted")) || !Long.valueOf(1).equals(stats.get("completed")) ||
                !Long.valueOf(0).equals(stats.get("failed")) || !Long.valueOf(0).equals(stats.get("rejected"))) {
                throw new AssertionError("Unexpected accounting: " + stats);
            }
            System.out.println("CONFIRMED: stop returned normally; two accepted queued callbacks never ran; submitted=3 completed=1 failed=0 rejected=0");
        } finally {
            release.countDown();
            pool.shutdownNow();
            pool.awaitTermination(1,TimeUnit.SECONDS);
        }
    }
}
