/**
 * Analyzer tests: Java AST -> structured facts -> semantic features.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { detectFeatures, featureIdsOf } from '../src/analyzer/feature-detector.ts';
import { parseJava } from '../src/analyzer/java-parser.ts';
import { buildThreadPoolModel } from '../src/analyzer/model-builder.ts';

function analyze(code: string): { model: ReturnType<typeof buildThreadPoolModel>; features: string[] } {
  const parsed = parseJava(code, 'Test.java');
  const model = buildThreadPoolModel(parsed);
  return { model, features: featureIdsOf(detectFeatures(model)) };
}

describe('analyzer: thread pool creation', () => {
  it('detects an explicit ThreadPoolExecutor with all seven arguments', () => {
    const { model, features } = analyze(`
      class A {
        private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
            8, 16, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(200),
            namedFactory("order"),
            new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
      }`);
    assert.equal(model.pools.length, 1);
    const pool = model.pools[0];
    assert.equal(pool?.kind, 'thread_pool_executor');
    assert.equal(pool?.scope, 'field');
    assert.equal(pool?.coreSize?.number, 8);
    assert.equal(pool?.maxSize?.number, 16);
    assert.equal(pool?.keepAlive?.number, 60);
    assert.equal(pool?.queue?.typeName, 'ArrayBlockingQueue');
    assert.equal(pool?.queue?.capacity, 200);
    assert.equal(pool?.queue?.bounded, true);
    assert.equal(pool?.rejection?.kind, 'caller_runs');
    assert.equal(pool?.threadFactory?.typeName, 'namedFactory("order")');
    for (const feature of [
      'THREAD_POOL.CREATE',
      'THREAD_POOL.CONFIG.CORE_SIZE',
      'THREAD_POOL.CONFIG.MAX_SIZE',
      'THREAD_POOL.CONFIG.KEEP_ALIVE',
      'THREAD_POOL.CONFIG.QUEUE',
      'THREAD_POOL.CONFIG.REJECTION',
      'THREAD_POOL.CONFIG.THREAD_FACTORY',
    ]) {
      assert.ok(features.includes(feature), `expected feature ${feature}`);
    }
  });

  it('expands the documented semantics of the Executors factories', () => {
    const { model } = analyze(`
      class A {
        private final java.util.concurrent.ExecutorService a = java.util.concurrent.Executors.newFixedThreadPool(16);
        private final java.util.concurrent.ExecutorService b = java.util.concurrent.Executors.newCachedThreadPool();
        private final java.util.concurrent.ScheduledExecutorService c = java.util.concurrent.Executors.newScheduledThreadPool(2);
      }`);
    assert.equal(model.pools.length, 3);
    const [fixed, cached, scheduled] = model.pools;
    assert.equal(fixed?.queue?.bounded, false, 'newFixedThreadPool uses an unbounded LinkedBlockingQueue');
    assert.equal(fixed?.coreSize?.number, 16);
    assert.equal(cached?.maxSize?.number, 2147483647);
    assert.equal(cached?.queue?.typeName, 'SynchronousQueue');
    assert.equal(scheduled?.isScheduled, true);
    assert.equal(scheduled?.queue, undefined, 'scheduled queues are implicit (DelayedWorkQueue)');
  });

  it('detects transient pools created inside a method', () => {
    const { model, features } = analyze(`
      class A {
        void run() {
          java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newSingleThreadExecutor();
          executor.execute(() -> work());
        }
      }`);
    assert.equal(model.pools[0]?.scope, 'local');
    assert.ok(features.includes('THREAD_POOL.CREATE.PER_REQUEST'));
    assert.ok(features.includes('THREAD_POOL.CREATE.EXECUTORS_FACTORY'));
  });

  it('detects virtual thread executors', () => {
    const { model, features } = analyze(`
      class A {
        private final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
      }`);
    assert.equal(model.pools[0]?.kind, 'virtual_thread_executor');
    assert.ok(features.includes('VIRTUAL_THREAD'));
    assert.ok(!features.includes('THREAD_POOL.CREATE.EXECUTORS_FACTORY'), 'virtual threads are not a risky factory');
  });

  it('detects `Thread.startVirtualThread` without a pool', () => {
    const { features } = analyze(`
      class A {
        void notify(String id) { Thread.startVirtualThread(() -> send(id)); }
      }`);
    assert.ok(features.includes('VIRTUAL_THREAD'));
  });

  it('detects Spring task executors configured through setters', () => {
    const { model, features } = analyze(`
      class Config {
        @Bean("orderNotifier")
        public org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor orderNotifier() {
          org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor executor =
              new org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor();
          executor.setCorePoolSize(8);
          executor.setMaxPoolSize(16);
          executor.setQueueCapacity(200);
          executor.setThreadNamePrefix("order-notify-");
          executor.setRejectedExecutionHandler(new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
          return executor;
        }
      }`);
    const pool = model.pools[0];
    assert.equal(pool?.kind, 'spring_task_executor');
    assert.equal(pool?.isBean, true);
    assert.equal(pool?.coreSize?.number, 8);
    assert.equal(pool?.queue?.capacity, 200);
    assert.equal(pool?.rejection?.kind, 'abort');
    assert.equal(pool?.threadFactory?.setsName, true, 'setThreadNamePrefix implies named threads');
    assert.ok(features.includes('SPRING.EXECUTOR_BEAN'));
  });

describe('analyzer: task submission and lifecycle', () => {
  it('records submit / execute with receiver resolution and result usage', () => {
    const { model, features } = analyze(`
      class A {
        private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
            2, 4, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(10));
        void work() throws Exception {
          pool.submit(() -> risky());
          java.util.concurrent.Future<?> future = pool.submit(() -> risky());
          future.get(3, java.util.concurrent.TimeUnit.SECONDS);
        }
      }`);
    assert.equal(model.submits.length, 2);
    assert.equal(model.submits[0]?.resultUsed, false);
    assert.equal(model.submits[1]?.resultUsed, true);
    assert.equal(model.futureGets.length, 1);
    assert.equal(model.futureGets[0]?.hasTimeout, true);
    assert.ok(features.includes('THREAD_POOL.FUTURE.GET'));
  });

  it('flags submit tasks that throw and records the shutdown sequence', () => {
    const { model, features } = analyze(`
      class A {
        private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
            2, 4, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(10));
        void work() {
          pool.execute(() -> { throw new IllegalStateException("boom"); });
        }
        void stop() {
          pool.shutdown();
          try {
            if (!pool.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS)) {
              java.util.List<Runnable> pending = pool.shutdownNow();
              log(pending);
            }
          } catch (InterruptedException ex) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
          }
        }
      }`);
    assert.equal(model.submits[0]?.taskThrows, true);
    assert.ok(features.includes('THREAD_POOL.EXCEPTION'));
    assert.ok(features.includes('THREAD_POOL.SHUTDOWN'));
    assert.ok(features.includes('THREAD_POOL.SHUTDOWN_NOW'));
    assert.ok(features.includes('THREAD_POOL.AWAIT_TERMINATION'));
    assert.equal(model.interruptCatches.length, 1);
    assert.equal(model.interruptCatches[0]?.restored, true);
  });

  it('tracks monitoring accessors and thread local usage', () => {
    const { model, features } = analyze(`
      class A {
        private static final ThreadLocal<String> TENANT = new ThreadLocal<>();
        private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
            2, 4, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(10));
        String stats() { return pool.getActiveCount() + "/" + pool.getQueue().size(); }
        void work() { TENANT.set("t"); }
      }`);
    assert.ok(model.monitors.length >= 2);
    assert.ok(features.includes('THREAD_POOL.MONITOR'));
    assert.ok(features.includes('THREAD_POOL.THREAD_LOCAL'));
  });

  it('detects CompletableFuture without an explicit executor', () => {
    const { model, features } = analyze(`
      class A {
        java.util.concurrent.CompletableFuture<String> quote() {
          return java.util.concurrent.CompletableFuture.supplyAsync(() -> "q");
        }
      }`);
    assert.equal(model.asyncs[0]?.kind, 'completable_future');
    assert.equal(model.asyncs[0]?.hasExplicitExecutor, false);
    assert.ok(features.includes('THREAD_POOL.COMPLETABLE_FUTURE'));
  });
});

describe('analyzer: robustness', () => {
  it('reports syntax errors without throwing', () => {
    const parsed = parseJava('class A { void x( { } }', 'Broken.java');
    assert.ok(parsed.errors.length > 0);
    assert.equal(buildThreadPoolModel(parsed).pools.length, 0);
  });

  it('produces no features for plain business code', () => {
    const { features } = analyze(`
      class Calculator {
        int add(int a, int b) {
          return a + b;
        }
      }`);
    assert.deepEqual(features, []);
  });
});

});
