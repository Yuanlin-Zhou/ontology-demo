/**
 * Validator tests: the deterministic checkers must produce the documented
 * violations and must not fire on compliant code.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RuleEngine } from '../src/api/engine.ts';

const engine = RuleEngine.load({ strictFeatures: true });

const BAD = `
package com.example;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

class Bad {
  private final ThreadPoolExecutor unbounded = new ThreadPoolExecutor(
          0, Integer.MAX_VALUE, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>());
  private final java.util.concurrent.ExecutorService factory = Executors.newFixedThreadPool(8);

  void work() {
    unbounded.submit(() -> risky());
    factory.execute(() -> risky());
  }
}`;

const GOOD = `
package com.example;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class Good {
  private final ThreadPoolExecutor pool = new ThreadPoolExecutor(
          4, 8, 60L, TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(200),
          namedFactory("good"),
          new ThreadPoolExecutor.AbortPolicy());

  void work(String id) {
    try {
      pool.execute(() -> risky(id));
    } catch (RejectedExecutionException ex) {
      fallback.offer(id);
    }
  }

  String stats() {
    return pool.getActiveCount() + "/" + pool.getQueue().size();
  }

  @PreDestroy
  void stop() {
    pool.shutdown();
    try {
      if (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
        List<Runnable> pending = pool.shutdownNow();
        log(pending.size());
      }
    } catch (InterruptedException ex) {
      List<Runnable> pending = pool.shutdownNow();
      log(pending.size());
      Thread.currentThread().interrupt();
    }
  }

  private static ThreadFactory namedFactory(String prefix) {
    AtomicInteger sequence = new AtomicInteger();
    return task -> {
      Thread thread = new Thread(task);
      thread.setName(prefix + "-" + sequence.incrementAndGet());
      return thread;
    };
  }
}`;

describe('validator: violations', () => {
  it('tracks a pool assigned to a field in the constructor and still checks shutdown', () => {
    const code = `class A {
      private final java.util.concurrent.ExecutorService pool;
      A() { this.pool = new java.util.concurrent.ThreadPoolExecutor(1,2,1,java.util.concurrent.TimeUnit.SECONDS,new java.util.concurrent.ArrayBlockingQueue<>(8)); }
    }`;
    const result = engine.validate({ code });
    assert.equal(result.violations.some(v => v.rule_id === 'TP-CREATE-002'), false);
    assert.ok(result.violations.some(v => v.rule_id === 'TP-SHUTDOWN-001'));
    assert.equal(engine.analyze({ code }).model.pools[0]?.variableName, 'pool');
  });
  it('recognises a private factory used solely for constructor field initialization', () => {
    const code = `class A {
      private final java.util.concurrent.ExecutorService pool;
      A() { this.pool = build(); }
      private static java.util.concurrent.ExecutorService build() {
        java.util.concurrent.ExecutorService local = java.util.concurrent.Executors.newFixedThreadPool(2);
        return local;
      }
    }`;
    const result = engine.validate({ code });
    assert.equal(result.violations.some(v => v.rule_id === 'TP-CREATE-002'), false);
    assert.ok(result.violations.some(v => v.rule_id === 'TP-SHUTDOWN-001'));
    assert.equal(engine.analyze({ code }).model.pools[0]?.variableName, 'pool');
    const closed = code.replace('A() { this.pool = build(); }', 'A() { this.pool = build(); } void stop() { pool.shutdown(); }');
    assert.equal(engine.validate({ code: closed }).violations.some(v => v.rule_id === 'TP-SHUTDOWN-001'), false);
  });
  it('retains per-request warnings when a private factory also runs from a normal method', () => {
    const code = `class A {
      private final java.util.concurrent.ExecutorService pool = build();
      void request() { java.util.concurrent.ExecutorService temporary = build(); }
      private static java.util.concurrent.ExecutorService build() { return java.util.concurrent.Executors.newFixedThreadPool(2); }
    }`;
    assert.ok(engine.validate({ code }).violations.some(v => v.rule_id === 'TP-CREATE-002'));
  });
  it('does not confuse a shadowed constructor local with the field', () => {
    const code = `class A {
      java.util.concurrent.ExecutorService pool;
      A() { java.util.concurrent.ExecutorService pool; pool = java.util.concurrent.Executors.newFixedThreadPool(2); }
    }`;
    assert.ok(engine.validate({ code }).violations.some(v => v.rule_id === 'TP-CREATE-002'));
    assert.equal(engine.analyze({ code }).model.pools[0]?.scope, 'expression');
  });
  it('recognises a constructor local that escapes only to its service field', () => {
    const code = `class A {
      private final java.util.concurrent.ExecutorService pool;
      A() { java.util.concurrent.ExecutorService value = java.util.concurrent.Executors.newFixedThreadPool(2); this.pool = value; }
    }`;
    const result = engine.validate({ code });
    assert.equal(result.violations.some(v => v.rule_id === 'TP-CREATE-002'), false);
    assert.ok(result.violations.some(v => v.rule_id === 'TP-SHUTDOWN-001'));
  });
  it('does not treat deferred lambda assignments as constructor initialization', () => {
    const code = `class A {
      java.util.concurrent.ExecutorService pool;
      Runnable callback;
      A() { callback = () -> { this.pool = java.util.concurrent.Executors.newFixedThreadPool(2); }; }
    }`;
    assert.ok(engine.validate({ code }).violations.some(v => v.rule_id === 'TP-CREATE-002'));
  });
  it('reports the documented violations for a violating file', () => {
    const result = engine.validate({ code: BAD, filePath: 'Bad.java' });
    const ruleIds = new Set(result.violations.map((violation) => violation.rule_id));
    for (const expected of [
      'TP-CREATE-001',
      'TP-CREATE-003',
      'TP-CONFIG-001',
      'TP-CONFIG-002',
      'TP-CONFIG-003',
      'TP-CONFIG-004',
      'TP-REJECT-003',
      'TP-SHUTDOWN-001',
      'TP-SUBMIT-001',
    ]) {
      assert.ok(ruleIds.has(expected), `expected violation ${expected}, got ${[...ruleIds].join(', ')}`);
    }
  });

  it('attaches location, snippet and repair suggestion to every violation', () => {
    const result = engine.validate({ code: BAD, filePath: 'Bad.java' });
    assert.ok(result.violations.length > 0);
    for (const violation of result.violations) {
      assert.ok(violation.line >= 1, `${violation.rule_id}: missing line`);
      assert.ok(violation.column >= 1, `${violation.rule_id}: missing column`);
      assert.ok(violation.snippet.length > 0, `${violation.rule_id}: missing snippet`);
      assert.ok(violation.suggestion.length > 10, `${violation.rule_id}: missing suggestion`);
    }
  });

  it('does not report error-severity violations for compliant code', () => {
    const result = engine.validate({ code: GOOD, filePath: 'Good.java' });
    const errors = result.violations.filter((violation) => violation.severity === 'error');
    assert.deepEqual(errors, [], `unexpected errors: ${errors.map((violation) => violation.rule_id).join(', ')}`);
    assert.ok(result.stats.checked_rules > 5);
  });

  it('restricts the check to the requested rule ids', () => {
    const result = engine.validate({ code: BAD, filePath: 'Bad.java', ruleIds: ['TP-CONFIG-004'] });
    assert.deepEqual(result.checked_rules, ['TP-CONFIG-004']);
    assert.deepEqual(new Set(result.violations.map((violation) => violation.rule_id)), new Set(['TP-CONFIG-004']));
  });

  it('warns about unknown rule ids instead of failing', () => {
    const result = engine.validate({ code: BAD, filePath: 'Bad.java', ruleIds: ['TP-NOPE-999'] });
    assert.ok(result.warnings.some((warning) => warning.includes('TP-NOPE-999')));
    assert.equal(result.violations.length, 0);
  });

  it('recognises the ThreadLocal cleanup delegated to a helper', () => {
    const code = `
      class A {
        private static final ThreadLocal<String> TENANT = new ThreadLocal<>();
        void work() {
          String previous = TENANT.get();
          TENANT.set("t");
          try {
            run();
          } finally {
            restore(previous);
          }
        }
        private static void restore(String previous) {
          if (previous == null) {
            TENANT.remove();
          } else {
            TENANT.set(previous);
          }
        }
      }`;
    const result = engine.validate({ code, filePath: 'A.java', ruleIds: ['TP-SUBMIT-004'] });
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  });

  it('still reports ThreadLocal usage without any cleanup', () => {
    const code = `
      class A {
        private static final ThreadLocal<String> TENANT = new ThreadLocal<>();
        void work() {
          TENANT.set("t");
          run();
        }
      }`;
    const result = engine.validate({ code, filePath: 'A.java', ruleIds: ['TP-SUBMIT-004'] });
    assert.equal(result.violations.length, 1);
  });
});
