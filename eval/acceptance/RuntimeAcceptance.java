import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;

/** Runtime checks for observable executor behavior; full task completion still requires review. */
class RuntimeAcceptance {
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void requireAdapter(boolean value, String message) {
        if (!value) { System.out.println("UNAVAILABLE_ADAPTER: " + message); System.exit(77); }
    }
    static Object field(Object service, String name) throws Exception {
        Field field = service.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(service);
    }
    static long rejectionCount(Object stats) throws Exception {
        if (stats instanceof Number number) return number.longValue();
        if (stats instanceof Map<?, ?> map) {
            for (var entry : map.entrySet()) {
                if (rejectionName(String.valueOf(entry.getKey())) && entry.getValue() instanceof Number number) return number.longValue();
            }
        }
        if (stats instanceof CharSequence text) {
            var matcher = java.util.regex.Pattern.compile("(?i)(?:rejected|rejections|rejectedCount|dropped|discarded)\\s*[=:]\\s*(\\d+)").matcher(text);
            if (matcher.find()) return Long.parseLong(matcher.group(1));
            if (text.toString().matches("\\d+/\\d+/\\d+")) return Long.parseLong(text.toString().split("/")[2]);
        }
        if (stats != null) {
            for (Method method : stats.getClass().getMethods()) {
                if (method.getParameterCount() == 0 && rejectionName(method.getName())) {
                    Object value = method.invoke(stats);
                    if (value instanceof Number number) return number.longValue();
                }
            }
        }
        requireAdapter(false, "Cannot identify numeric rejection counter from stats()");
        return 0;
    }
    static boolean rejectionName(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.contains("reject") || lower.contains("drop") || lower.contains("discard");
    }
    static void beanAcceptance(Class<?> target, String caseId) throws Exception {
        // Real Spring classes from the configured classpath. No simulated container.
        Class<?> contextType = Class.forName("org.springframework.context.annotation.AnnotationConfigApplicationContext");
        Object context = contextType.getConstructor(Class[].class).newInstance((Object) new Class<?>[]{target});
        ExecutorService executor = null;
        try {
            Object bean = contextType.getMethod("getBean", String.class).invoke(context, "orderNotifier");
            executor = bean instanceof ExecutorService e ? e : (ExecutorService) bean.getClass().getMethod("getThreadPoolExecutor").invoke(bean);
            require(executor.submit(() -> "bean-work").get(2, TimeUnit.SECONDS).equals("bean-work"), "Spring bean cannot execute work");
            if (caseId.equals("CASE-016")) {
                Object config = contextType.getMethod("getBean", Class.class).invoke(context, target);
                Method stats = Arrays.stream(target.getMethods())
                    .filter(m -> m.getName().equals("stats") && (m.getParameterCount() == 0 ||
                        (Modifier.isStatic(m.getModifiers()) && m.getParameterCount() == 1 && m.getParameterTypes()[0].isInstance(bean))))
                    .sorted(Comparator.comparingInt(Method::getParameterCount)).findFirst().orElseThrow();
                Object observed = stats.getParameterCount() == 0 ? stats.invoke(config) : stats.invoke(config, bean);
                require(observed != null && !observed.toString().isBlank(), "Empty pool metrics");
            }
        } finally { contextType.getMethod("close").invoke(context); }
        require(executor != null && executor.isShutdown(), "Container close did not reclaim executor");
    }
    public static void main(String[] args) throws Exception {
        Class<?> target = Class.forName(args[0]);
        if (args[1].equals("CASE-016") || args[1].equals("CASE-021")) { beanAcceptance(target, args[1]); return; }
        Object service = target.getConstructor().newInstance();
        List<ExecutorService> executors = new ArrayList<>();
        for (Field field : target.getDeclaredFields()) {
            if (ExecutorService.class.isAssignableFrom(field.getType())) {
                field.setAccessible(true);
                Object value = field.get(service);
                if (value instanceof ExecutorService executor) executors.add(executor);
            }
        }
        requireAdapter(!executors.isEmpty(), "No observable ExecutorService field");
        try {
            ExecutorService executor = executors.get(0);
            switch (args[1]) {
                case "CASE-001", "CASE-002" -> {
                    requireAdapter(executor instanceof ThreadPoolExecutor, "Expected observable service-owned pool");
                    var pool = (ThreadPoolExecutor) executor;
                    // One worker makes the thread-context reuse regression deterministic.
                    if (args[1].equals("CASE-002")) { pool.setCorePoolSize(1); pool.setMaximumPoolSize(1); }
                    Class<?> order = Class.forName("com.example.order.domain.Order");
                    Object input = order.getConstructor(String.class, String.class).newInstance("order-1", "tenant-1");
                    long before = pool.getTaskCount();
                    target.getMethod(args[1].equals("CASE-001") ? "notifyCreated" : "syncCreated", order).invoke(service, input);
                    require(pool.getTaskCount() > before, "Public API did not dispatch work to the service pool");
                    pool.submit(() -> {}).get(2, TimeUnit.SECONDS);
                    if (args[1].equals("CASE-002")) {
                        ThreadLocal<?> tenant = (ThreadLocal<?>) field(service, "TENANT");
                        require(pool.submit(tenant::get).get(2, TimeUnit.SECONDS) == null, "Tenant context leaked to the next job");
                    }
                }
                case "CASE-003" -> {
                    requireAdapter(executor instanceof ThreadPoolExecutor, "Expected a bounded export executor");
                    var pool = (ThreadPoolExecutor) executor;
                    require(pool.getQueue().remainingCapacity() < Integer.MAX_VALUE, "Unbounded export queue");
                    require(pool.submit(() -> "export-work").get(2, TimeUnit.SECONDS).equals("export-work"), "Executor cannot execute work");
                }
                case "CASE-005" -> {
                    requireAdapter(executor instanceof ThreadPoolExecutor, "Expected configurable pool");
                    var pool = (ThreadPoolExecutor) executor;
                    require(pool.getMaximumPoolSize() > pool.getCorePoolSize(), "Cannot expand at peak load");
                    require(pool.getKeepAliveTime(TimeUnit.MILLISECONDS) > 0, "Non-core threads have no useful keep-alive");
                    require(pool.getKeepAliveTime(TimeUnit.SECONDS) < Long.MAX_VALUE / 1000, "No bounded idle expiry");
                }
                case "CASE-004" -> {
                    requireAdapter(executor instanceof ScheduledThreadPoolExecutor, "Expected retry scheduler");
                    var pool = (ScheduledThreadPoolExecutor) executor;
                    target.getMethod("scheduleRetry", String.class).invoke(service, "order-1");
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
                    while (pool.getCompletedTaskCount() == 0 && System.nanoTime() < deadline) Thread.sleep(20);
                    require(pool.getCompletedTaskCount() > 0, "Retry was never executed");
                    require(!pool.getQueue().isEmpty(), "Retry was not rescheduled");
                }
                case "CASE-007", "CASE-009" -> {
                    executor.shutdown();
                    long before = rejectionCount(target.getMethod("stats").invoke(service));
                    try {
                        target.getMethod(args[1].equals("CASE-007") ? "write" : "dispatch", String.class).invoke(service, "rejected-1");
                    } catch (InvocationTargetException error) {
                        if (!(error.getCause() instanceof RejectedExecutionException)) throw error;
                    }
                    long after = rejectionCount(target.getMethod("stats").invoke(service));
                    require(after > before, "Rejection did not increment observable rejection counter");
                }
                case "CASE-008" -> {
                    executor.shutdown();
                    target.getMethod("sync", String.class).invoke(service, "sku-rejected");
                    Object retries = field(service, "retryQueue");
                    require(retries instanceof Collection<?> queue && queue.contains("sku-rejected"), "Rejected SKU was not retained for retry");
                }
                case "CASE-010" -> {
                    String name = executor.submit(() -> Thread.currentThread().getName()).get(2, TimeUnit.SECONDS);
                    require(!name.matches("(?:pool-\\d+-thread-|Thread-)\\d+"), "Default thread name: " + name);
                    require(name.toLowerCase().contains("file"), "Thread name must identify file processing: " + name);
                    target.getMethod("process", String.class).invoke(service, "test-file");
                }
                case "CASE-011" -> {
                    requireAdapter(executor instanceof ThreadPoolExecutor, "Expected reusable push pool");
                    var pool = (ThreadPoolExecutor) executor;
                    long before = pool.getTaskCount();
                    target.getMethod("onEvent", String.class).invoke(service, "event-1");
                    target.getMethod("onEvent", String.class).invoke(service, "event-2");
                    require(pool.getTaskCount() >= before + 2, "Events did not use the service-owned executor");
                    require(!pool.isShutdown(), "Executor was closed after each request");
                }
                case "CASE-013" -> {
                    CountDownLatch started = new CountDownLatch(1);
                    CountDownLatch release = new CountDownLatch(1);
                    CountDownLatch completed = new CountDownLatch(1);
                    executor.execute(() -> {
                        started.countDown();
                        try { release.await(); completed.countDown(); }
                        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    });
                    require(started.await(2, TimeUnit.SECONDS), "Work did not start");
                    Thread releaser = new Thread(() -> {
                        try { Thread.sleep(200); release.countDown(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    });
                    releaser.setDaemon(true);
                    releaser.start();
                    target.getMethod("stop").invoke(service);
                    require(completed.getCount() == 0, "stop returned before accepted work finished");
                    require(executor.isShutdown(), "Pool not shut down");
                }
                case "CASE-014" -> {
                    CountDownLatch started = new CountDownLatch(1);
                    executor.execute(() -> {
                        started.countDown();
                        try { new CountDownLatch(1).await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    });
                    require(started.await(2, TimeUnit.SECONDS), "Work did not start");
                    Thread.currentThread().interrupt();
                    try { target.getMethod("stop").invoke(service); require(Thread.currentThread().isInterrupted(), "Interrupt was swallowed"); }
                    finally { Thread.interrupted(); }
                    require(executor.isShutdown(), "Interrupted stop did not shut down the pool");
                }
                case "CASE-015" -> {
                    requireAdapter(executor instanceof ThreadPoolExecutor, "Expected controllable audit pool");
                    var pool = (ThreadPoolExecutor) executor;
                    pool.setCorePoolSize(1); pool.setMaximumPoolSize(1);
                    CountDownLatch started = new CountDownLatch(1);
                    pool.execute(() -> {
                        started.countDown();
                        try { new CountDownLatch(1).await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    });
                    require(started.await(2, TimeUnit.SECONDS), "Work did not start");
                    Runnable pending = () -> {};
                    pool.execute(pending);
                    Thread.currentThread().interrupt();
                    try { target.getMethod("stop").invoke(service); } finally { Thread.interrupted(); }
                    Object fallback = field(service, "fallbackQueue");
                    require(fallback instanceof Collection<?> queue && queue.contains(pending), "Pending audit task was not transferred to compensation");
                }
                case "CASE-018" -> {
                    require(executors.size() >= 2 && executors.get(0) != executors.get(1), "Settlement and retry must use distinct executors");
                    require(executors.stream().anyMatch(e -> e instanceof ScheduledExecutorService), "No retry scheduler");
                    target.getMethod("settle", String.class).invoke(service, "bill-1");
                    target.getMethod("stop").invoke(service);
                    require(executors.stream().allMatch(ExecutorService::isShutdown), "Both executors must shut down");
                }
                case "CASE-020" -> {
                    Map<ThreadLocal<?>, Object> callerContext = new IdentityHashMap<>();
                    for (Field field : target.getDeclaredFields()) {
                        if (ThreadLocal.class.isAssignableFrom(field.getType()) && Modifier.isStatic(field.getModifiers())) {
                            field.setAccessible(true);
                            ThreadLocal<?> context = (ThreadLocal<?>) field.get(null);
                            callerContext.put(context, context.get());
                        }
                    }
                    Object result = target.getMethod("export", String.class).invoke(service, "report-1");
                    for (var entry : callerContext.entrySet()) {
                        require(Objects.equals(entry.getValue(), entry.getKey().get()), "Caller tenant context leaked or changed after export");
                    }
                    require("report-report-1".equals(result), "Wrong generated report: " + result);
                    for (Field field : target.getDeclaredFields()) {
                        if (ThreadLocal.class.isAssignableFrom(field.getType()) && Modifier.isStatic(field.getModifiers())) {
                            field.setAccessible(true);
                            ThreadLocal<?> context = (ThreadLocal<?>) field.get(null);
                            require(executor.submit(context::get).get(2, TimeUnit.SECONDS) == null, "Worker tenant context leaked");
                        }
                    }
                }
                default -> throw new AssertionError("Unknown runtime case: " + args[1]);
            }
        } finally {
            for (ExecutorService executor : executors) executor.shutdownNow();
        }
    }
}
