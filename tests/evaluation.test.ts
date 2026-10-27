import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { describe, it } from 'node:test';
import { outcomeRate, ruleCompliance } from '../eval/metrics.ts';
import { acceptanceTest, readTaskReview, sha256, TASK_CRITERIA } from '../eval/acceptance.ts';
import { checkJava, javaIdentity } from '../eval/java.ts';
import { runEvaluation, renderReportMarkdown } from '../eval/runner.ts';
import { validateExperimentConfig, runExperiment } from '../eval/experiment.ts';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';
import { chatEndpoint, providerParameters } from '../eval/providers/openai-compatible.ts';
import { extractJavaSource } from '../eval/model-output.ts';
import { deliveryContract } from '../eval/delivery-contract.ts';

const javac = process.env['EVAL_JAVAC'] ?? 'javac';
const java = process.env['EVAL_JAVA'] ?? 'java';
const hasJdk = spawnSync(javac, ['-version']).status === 0;
const classpath = process.env['EVAL_CLASSPATH']?.split(delimiter);

function temporary(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rule-eval-test-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('evaluation metrics and reviews', () => {
  it('extracts one fenced block without rewriting Java or losing raw provenance', () => {
    const code = 'public class A { String ticks = "```"; }\n';
    assert.equal(extractJavaSource(code).code, code);
    const raw = '```java\n' + code + '\n```\n';
    const result = extractJavaSource(raw);
    assert.equal(result.code, code);
    assert.equal(result.format, 'single_fenced_block');
    assert.equal(result.raw_sha256, sha256(raw));
    assert.equal(result.source_sha256, sha256(code));
    assert.throws(() => extractJavaSource('```java\nclass A {}\n```\n```java\nclass B {}\n```'), /exactly one/);
    assert.throws(() => extractJavaSource('Here is code:\n```java\nclass A {}\n```'), /unambiguously/);
    assert.throws(() => extractJavaSource('```java\nclass A {}'), /exactly one/);
    assert.throws(() => extractJavaSource('```python\nprint(1)\n```'), /exactly one/);
  });
  it('deduplicates violated rules and leaves zero-rule compliance undefined', () => {
    assert.equal(ruleCompliance(['A', 'B'], ['A', 'A', 'A']), 0.5);
    assert.equal(ruleCompliance(['A'], ['unknown']), 1);
    assert.equal(ruleCompliance([], []), null);
    assert.deepEqual(outcomeRate(['ok', 'failed', 'timeout', 'unavailable', 'not_run']), { passed: 1, total: 5, rate: 0.2, evaluated: 3 });
  });
  it('requires complete, evidence-backed reviews bound to the exact source', () => temporary(dir => {
    const file = join(dir, 'review.json');
    const source = 'class A {}';
    const review = { source_sha256: sha256(source), reviewer: 'reviewer', criteria: TASK_CRITERIA['CASE-019']!.map(criterion => ({ criterion, passed: true, evidence: 'Acceptance run log and source review' })) };
    writeFileSync(file, JSON.stringify(review));
    assert.equal(readTaskReview(file, source, 'CASE-019').status, 'ok');
    review.criteria[0]!.passed = false;
    review.criteria[0]!.evidence = 'VIP calculation was discarded';
    writeFileSync(file, JSON.stringify(review));
    assert.match(readTaskReview(file, source, 'CASE-019').detail, /VIP calculation was discarded/);
    assert.equal(readTaskReview(file, source + ' ', 'CASE-019').status, 'not_run');
    review.criteria[0]!.evidence = '';
    writeFileSync(file, JSON.stringify(review));
    assert.equal(readTaskReview(file, source, 'CASE-019').status, 'not_run');
  }));
  it('records all planned results, including missing and syntactically invalid outputs', () => temporary(dir => {
    const resultDir = join(dir, 'results', 'baseline');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, 'CASE-001.java'), 'public class Broken { void broken() { int x = ; } }');
    const report = runEvaluation({ casesDir: join(REPOSITORY_ROOT, 'cases'), outputDir: dir, evaluateAgentResults: true, java: { javac: join(dir, 'missing-javac') } });
    assert.equal(report.agent.length, 63);
    assert.equal(report.agent.filter(item => item.output === 'missing').length, 62);
    const invalid = report.agent.find(item => item.output === 'invalid')!;
    assert.equal(invalid.compliance, null);
    assert.equal(invalid.compile, 'unavailable');
    assert.match(renderReportMarkdown(report), /Missing \/ Invalid/);
    assert.match(renderReportMarkdown(report), /Task Completion/);
  }));
  it('does not turn a passing review into task success when javac is unavailable', () => temporary(dir => {
    const source = readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-019-negative-control', 'before.java'), 'utf8');
    const results = join(dir, 'results', 'baseline');
    const reviews = join(dir, 'reviews', 'baseline');
    mkdirSync(results, { recursive: true }); mkdirSync(reviews, { recursive: true });
    writeFileSync(join(results, 'CASE-019.java'), source);
    writeFileSync(join(reviews, 'CASE-019.json'), JSON.stringify({ source_sha256: sha256(source), reviewer: 'reviewer',
      criteria: TASK_CRITERIA['CASE-019']!.map(criterion => ({ criterion, passed: true, evidence: 'Reviewed source behavior' })) }));
    const report = runEvaluation({ casesDir: join(REPOSITORY_ROOT, 'cases'), outputDir: dir,
      evaluateAgentResults: true, java: { javac: join(dir, 'missing-compiler') } });
    const result = report.agent.find(item => item.case_id === 'CASE-019' && item.strategy === 'baseline')!;
    assert.equal(result.task_check.status, 'not_run');
    assert.equal(result.compliance, null);
  }));
});

describe('real Java checks', () => {
  it('verifies actual scheduled retry effects, recovery after failure and stop semantics', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source=join(dir,'input.java');
    const good=readFileSync(join(REPOSITORY_ROOT,'cases/CASE-004-scheduled-retry/good.java'),'utf8');
    const options={javac,java,classpath,...acceptanceTest('CASE-004')};
    writeFileSync(source,good);const passed=checkJava(source,options);
    assert.equal(passed.compile.status,'ok',passed.compile.detail);assert.equal(passed.tests.status,'ok',passed.tests.detail);
    const mutants=[
      {code:good.replace('retryHandler.accept(orderId);','/* downstream never invoked */'),message:/did not recover for later periods/},
      {code:good.replace('log.warn("retry failed, order={}",orderId,error);','throw error;'),message:/did not recover for later periods/},
      {code:good.replace('scheduler.scheduleWithFixedDelay(', 'scheduler.scheduleAtFixedRate('),message:/fixed rate or ignored delay/},
      {code:good.replace('},initialDelayMillis,delayMillis,TimeUnit.MILLISECONDS);','},0,delayMillis,TimeUnit.MILLISECONDS);'),message:/Initial retry delay ignored/},
      {code:good.replace('if(retryHandler==null)throw new IllegalStateException("Configure a payment retry callback before scheduling");','if(retryHandler==null)return;'),message:/Unconfigured downstream silently accepted/},
      {code:good.replace('scheduler.scheduleWithFixedDelay(()->{','scheduler.schedule(()->{').replace('},initialDelayMillis,delayMillis,TimeUnit.MILLISECONDS);','},initialDelayMillis,TimeUnit.MILLISECONDS);'),message:/did not recover for later periods/},
      {code:good.replace('pendingRetries.offer(orderId);','/* rejection lost */'),message:/compensation queue/},
      {code:good.replace('synchronized(lifecycle){scheduler.shutdown();}','synchronized(lifecycle){scheduler.shutdown();} if(scheduler.isShutdown())return;'),message:/stop returned before retry scheduler terminated|stop returned while retry was running/},
      {code:good.replace('Thread.currentThread().interrupt();throw new IllegalStateException("Retry shutdown interrupted",error);','throw new IllegalStateException("Retry shutdown interrupted",error);'),message:/swallowed caller interrupt/},
    ];
    for(const mutant of mutants){
      assert.notEqual(mutant.code,good);writeFileSync(source,mutant.code);const wrong=checkJava(source,options);
      assert.equal(wrong.compile.status,'ok',wrong.compile.detail);assert.equal(wrong.tests.status,'failed',wrong.tests.detail);
      assert.match(wrong.tests.detail??'',mutant.message);
    }
  }));

  it('verifies actual export cancellation, context restoration and queued shutdown completion', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source=join(dir,'input.java');
    const good=readFileSync(join(REPOSITORY_ROOT,'cases/CASE-020-mixed-export/good.java'),'utf8');
    const options={javac,java,classpath,...acceptanceTest('CASE-020')};
    writeFileSync(source,good);const passed=checkJava(source,options);
    assert.equal(passed.compile.status,'ok',passed.compile.detail);assert.equal(passed.tests.status,'ok',passed.tests.detail);
    const mutants=[
      {code:good.replace('task.cancel(true);\n        // Cancelled','CompletableFuture<?> completion=outstanding.get(task); if(completion!=null)completion.cancel(true);\n        // Cancelled'),message:/underlying work kept running/},
      {code:good.replace('exportExecutor.remove(task);','/* cancelled task retained */'),message:/still consumes capacity/},
      // The handle is cancelled and remove is present, but the queue owns a different object.
      {code:good.replace('exportExecutor.execute(task);','exportExecutor.execute(() -> task.run());'),message:/still consumes capacity/},
      {code:good.replace('finally{restore(workerPrevious);}','finally{/* context leaked */}'),message:/Worker context was not restored/},
      {code:good.replace('finally{restore(callerPrevious);}','finally{/* caller leaked */}'),message:/Empty caller context leaked/},
      {code:good.replace('for(FutureTask<Void> task:outstanding.keySet())task.cancel(true);','/* queued completion abandoned */'),message:/Shutdown stranded queued export caller/},
      {code:good.replace('cancelWork(task);Thread.currentThread().interrupt();','cancelWork(task);'),message:/Caller interrupt flag swallowed/},
      {code:good.replace('closed=true;exportExecutor.shutdown();','if(closed)return;closed=true;exportExecutor.shutdown();'),message:/Repeated stop returned before accepted export finished/},
      {code:good.replace('throw new IllegalStateException("export failed",cause);','throw new IllegalStateException("export failed");'),message:/Generator failure cause lost/},
      {code:good.replace('throw new IllegalStateException("Export work did not stop after interruption");','LOG.warning("Export work did not stop after interruption");'),message:/stop reported success while uninterruptible work/},
    ];
    const shutdownOptions={...options,testArgs:['queued-shutdown']};
    const shutdownPassed=checkJava(source,shutdownOptions);
    assert.equal(shutdownPassed.tests.status,'ok',shutdownPassed.tests.detail);
    writeFileSync(source,good.replace('for(FutureTask<Void> task:outstanding.keySet())task.cancel(true);','/* queued result abandoned */'));
    const shutdownFailed=checkJava(source,shutdownOptions);
    assert.equal(shutdownFailed.compile.status,'ok',shutdownFailed.compile.detail);
    assert.equal(shutdownFailed.tests.status,'failed',shutdownFailed.tests.detail);
    assert.match(shutdownFailed.tests.detail??'',/Shutdown stranded queued export caller/);
    for(const mutant of mutants){
      assert.notEqual(mutant.code,good);writeFileSync(source,mutant.code);const wrong=checkJava(source,options);
      assert.equal(wrong.compile.status,'ok',wrong.compile.detail);assert.equal(wrong.tests.status,'failed',wrong.tests.detail);
      assert.match(wrong.tests.detail??'',mutant.message);
    }
  }));
  it('verifies real virtual-thread downstream admission, permit release, counters and draining', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source=join(dir,'input.java');
    const good=readFileSync(join(REPOSITORY_ROOT,'cases/CASE-017-virtual-thread/good.java'),'utf8');
    const options={javac,java,...acceptanceTest('CASE-017')};
    writeFileSync(source,good);
    const passed=checkJava(source,options);
    assert.equal(passed.compile.status,'ok',passed.compile.detail);
    assert.equal(passed.tests.status,'ok',passed.tests.detail);
    const mutants=[
      {code:good.replace('Thread.startVirtualThread(() -> {','Thread.ofPlatform().start(() -> {'),message:/Actual downstream callback ran on a platform/},
      {code:good.replace('downstream.accept(orderId);','/* omitted downstream work */'),message:/Downstream callbacks never executed/},
      {code:good.replace('if (closed || !downstreamLimit.tryAcquire())','if (closed)'),message:/Saturated notification silently accepted|Downstream concurrency/},
      {code:good.replace('downstreamLimit.release();','/* leaked permit */'),message:/RejectedExecutionException|permit.*leaked/},
      {code:good.replace('rejected.incrementAndGet();','rejected.addAndGet(2);'),message:/Rejections not counted exactly once/},
      {code:good.replace('while (inFlight > 0)','while (inFlight < 0)'),message:/stop returned before accepted downstream finished|Interrupted caller lost accepted notification/},
      {code:good.replace('closed = true;','if (closed) return; closed = true;'),message:/Repeated stop returned before accepted downstream finished/},
    ];
    for(const mutant of mutants){
      assert.notEqual(mutant.code,good);
      writeFileSync(source,mutant.code);
      const wrong=checkJava(source,options);
      assert.equal(wrong.compile.status,'ok',wrong.compile.detail);
      assert.equal(wrong.tests.status,'failed',wrong.tests.detail);
      assert.match(wrong.tests.detail??'',mutant.message);
    }
  }));
  it('retains the actual assertion after noisy output within bounded diagnostic feedback', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source=join(dir,'Example.java'), test=join(dir,'Noisy.java');
    writeFileSync(source,'public class Example {}');
    writeFileSync(test,'class Noisy { public static void main(String[] args) { System.out.println("noise".repeat(5000)); throw new AssertionError("FINAL_TASK_FAILURE"); } }');
    const result=checkJava(source,{javac,java,testSource:test,testClass:'Noisy'});
    assert.equal(result.tests.status,'failed');
    assert.ok((result.tests.detail??'').length<=12000);
    assert.match(result.tests.detail??'',/diagnostics truncated/);
    assert.match(result.tests.detail??'',/AssertionError: FINAL_TASK_FAILURE/);
  }));
  it('checks priority dispatch, FIFO ties, bounded eviction, concurrent overflow and explicit rejection', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source=join(dir,'input.java');
    const good=readFileSync(join(REPOSITORY_ROOT,'cases/CASE-006-priority-queue-discard-oldest/good.java'),'utf8');
    const options={javac,java,...acceptanceTest('CASE-006')};
    writeFileSync(source,good);
    const pass=checkJava(source,options);
    assert.equal(pass.compile.status,'ok',pass.compile.detail);
    assert.equal(pass.tests.status,'ok',pass.tests.detail);
    // Preserve metadata and public API but silently use FIFO: the old acceptance missed this defect.
    const fifo=good.replace('Integer.compare(right.priority, left.priority)','0');
    assert.notEqual(fifo,good);
    writeFileSync(source,fifo);
    const wrongOrder=checkJava(source,options);
    assert.equal(wrongOrder.compile.status,'ok',wrongOrder.compile.detail);
    assert.equal(wrongOrder.tests.status,'failed');
    assert.match(wrongOrder.tests.detail??'',/Priority.*lost/);
    // Preserve execution priority but evict the most important task during overload.
    writeFileSync(source,good.replace('candidate.priority < victim.priority','candidate.priority > victim.priority')
      .replace('if (victim == null || victim.priority > task.priority)','if (victim == null)'));
    const wrongEviction=checkJava(source,options);
    assert.equal(wrongEviction.compile.status,'ok',wrongEviction.compile.detail);
    assert.equal(wrongEviction.tests.status,'failed');
    assert.match(wrongEviction.tests.detail??'',/highest priority/);
    writeFileSync(source,good.replace('4, 4, 60L','4, 8, 60L'));
    const bypass=checkJava(source,options);
    assert.equal(bypass.compile.status,'ok',bypass.compile.detail);
    assert.equal(bypass.tests.status,'failed');
    assert.match(bypass.tests.detail??'',/Production overload bypassed/);
  }));
  it('uses AST type names rather than names in comments', () => {
    assert.deepEqual(javaIdentity('// public class Wrong {}\npackage p; public record Correct(int x) {}'), { name: 'Correct', qualifiedName: 'p.Correct' });
  });
  it('distinguishes missing javac from code compilation failure', () => temporary(dir => {
    const source = join(dir, 'input.java');
    writeFileSync(source, 'public class Example {}');
    assert.equal(checkJava(source, { javac: join(dir, 'does-not-exist') }).compile.status, 'unavailable');
  }));
  it('compiles correct code, rejects invalid code and enforces functional assertions', { skip: !hasJdk && 'JDK unavailable; set EVAL_JAVAC/EVAL_JAVA' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const before = readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-019-negative-control', 'before.java'), 'utf8');
    writeFileSync(source, before);
    const options = { javac, java, ...acceptanceTest('CASE-019') };
    const pass = checkJava(source, options);
    assert.equal(pass.compile.status, 'ok', pass.compile.detail);
    assert.equal(pass.tests.status, 'ok', pass.tests.detail);
    writeFileSync(source, before.replace('new BigDecimal("0.95")', 'new BigDecimal("0.50")'));
    const wrong = checkJava(source, options);
    assert.equal(wrong.compile.status, 'ok', wrong.compile.detail);
    assert.equal(wrong.tests.status, 'failed');
    writeFileSync(source, 'public class Example { void broken() { missing(); } }');
    assert.equal(checkJava(source, options).compile.status, 'failed');
  }));
  it('times out a non-terminating functional test', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const test = join(dir, 'Hang.java');
    writeFileSync(source, 'public class Example {}');
    writeFileSync(test, 'class Hang { public static void main(String[] args) { while (true) {} } }');
    const result = checkJava(source, { javac, java, testSource: test, testClass: 'Hang', timeoutMs: 2000 });
    assert.equal(result.compile.status, 'ok', result.compile.detail);
    assert.equal(result.tests.status, 'timeout', result.tests.detail);
  }));
  it('distinguishes an unsupported test adapter from a failed implementation', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java'); const test = join(dir, 'Adapter.java');
    writeFileSync(source, 'public class Example {}');
    writeFileSync(test, 'class Adapter { public static void main(String[] args) { System.out.println("UNAVAILABLE_ADAPTER: opaque executor"); System.exit(77); } }');
    const result = checkJava(source, { javac, java, testSource: test, testClass: 'Adapter' });
    assert.equal(result.compile.status, 'ok', result.compile.detail);
    assert.equal(result.tests.status, 'unavailable');
  }));
  it('detects real graceful-shutdown and interrupt regressions', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const base = `import java.util.concurrent.*;
      public class Service {
        private final ExecutorService pool = Executors.newSingleThreadExecutor();
        public void stop() { pool.shutdown(); try { pool.awaitTermination(2, TimeUnit.SECONDS); }
          catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
      }`;
    writeFileSync(source, base);
    const options = { javac, java, ...acceptanceTest('CASE-013') };
    assert.equal(checkJava(source, options).tests.status, 'ok');
    writeFileSync(source, base.replace('pool.awaitTermination(2, TimeUnit.SECONDS);', 'if (false) throw new InterruptedException();'));
    assert.equal(checkJava(source, options).tests.status, 'failed');
    writeFileSync(source, base);
    assert.equal(checkJava(source, { javac, java, ...acceptanceTest('CASE-014') }).tests.status, 'ok');
    writeFileSync(source, base.replace('Thread.currentThread().interrupt();', '/* swallowed */'));
    assert.equal(checkJava(source, { javac, java, ...acceptanceTest('CASE-014') }).tests.status, 'failed');
  }));
  it('accepts counted rejections that propagate and rejects fresh statistics with unchanged counts', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const base = `import java.util.concurrent.*;
      public class Service {
        long rejected;
        final ExecutorService pool = new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1),
          (task, executor) -> { rejected++; throw new RejectedExecutionException(); });
        public void write(String text) { pool.execute(() -> {}); }
        public Stats stats() { return new Stats(rejected); }
        public static class Stats {
          final long count; Stats(long count) { this.count=count; }
          public long getRejected() { return count; }
        }
      }`;
    const options = { javac, java, ...acceptanceTest('CASE-007') };
    writeFileSync(source, base);
    const pass = checkJava(source, options);
    assert.equal(pass.compile.status, 'ok', pass.compile.detail);
    assert.equal(pass.tests.status, 'ok', pass.tests.detail);
    writeFileSync(source, base.replace('rejected++;', '/* no rejection count */'));
    const wrong = checkJava(source, options);
    assert.equal(wrong.tests.status, 'failed', wrong.tests.detail);
    assert.match(wrong.tests.detail ?? '', /did not increment/);
    writeFileSync(source, base.replace('public Stats stats() { return new Stats(rejected); }', 'public Object stats() { return new Object(); }'));
    assert.equal(checkJava(source, options).tests.status, 'unavailable');
  }));
  it('compiles a real ThreadFactory exception handler and rejects that API on an executor', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const code = `import java.util.concurrent.*;
      public class Example {
        ThreadFactory factory = task -> {
          Thread thread = new Thread(task);
          thread.setUncaughtExceptionHandler((t,e) -> System.err.println(e));
          return thread;
        };
        ThreadPoolExecutor pool = new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1),factory);
      }`;
    writeFileSync(source, code);
    assert.equal(checkJava(source, { javac, java }).compile.status, 'ok');
    writeFileSync(source, code.replace('thread.setUncaughtExceptionHandler', 'pool.setUncaughtExceptionHandler'));
    assert.equal(checkJava(source, { javac, java }).compile.status, 'failed');
  }));
  it('starts a real Spring context and checks container-owned shutdown', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    writeFileSync(source, readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-016-spring-bean-executor', 'good.java'), 'utf8'));
    const result = checkJava(source, { javac, java, classpath, ...acceptanceTest('CASE-016') });
    assert.equal(result.compile.status, 'ok', result.compile.detail);
    assert.equal(result.tests.status, 'ok', result.tests.detail);
    writeFileSync(source, readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-016-spring-bean-executor', 'before.java'), 'utf8'));
    const noMetrics = checkJava(source, { javac, java, classpath, ...acceptanceTest('CASE-016') });
    assert.equal(noMetrics.compile.status, 'ok', noMetrics.compile.detail);
    assert.equal(noMetrics.tests.status, 'failed');
  }));
  it('checks export caller context as well as worker context', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const source=join(dir,'Service.java');
    const base=`import java.util.concurrent.*; public class Service {
      private static final ThreadLocal<String> TENANT=new ThreadLocal<>();
      private final ExecutorService pool=Executors.newSingleThreadExecutor();
      private void validate(){TENANT.set("request");}
      public String export(String id){ validate(); try {
        return CompletableFuture.supplyAsync(()->"report-"+id,pool).get(1,TimeUnit.SECONDS);
      }catch(Exception e){throw new IllegalStateException(e);} }
    }`;
    // Retain the legacy context-only probe as its own regression; full CASE-020 has an injected callback contract.
    const options={javac,java,testSource:join(REPOSITORY_ROOT,'eval/acceptance/RuntimeAcceptance.java'),testClass:'RuntimeAcceptance',testArgs:['CASE-020']};
    writeFileSync(source,base);const wrong=checkJava(source,options);
    assert.equal(wrong.compile.status,'ok',wrong.compile.detail);assert.equal(wrong.tests.status,'failed');assert.match(wrong.tests.detail,/Caller tenant context/);
    writeFileSync(source,base.replace('validate(); try {','try { validate();').replace('throw new IllegalStateException(e);} }','throw new IllegalStateException(e);} finally {TENANT.remove();} }'));
    const fixed=checkJava(source,options);assert.equal(fixed.compile.status,'ok',fixed.compile.detail);assert.equal(fixed.tests.status,'ok',fixed.tests.detail);
  }));
  it('chooses a compatible Spring stats overload instead of an unrelated String adapter', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const base = readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-016-spring-bean-executor', 'good.java'), 'utf8');
    const code = base.replace('public class AsyncExecutorConfig {', `public class AsyncExecutorConfig {
      public static String stats(String unrelated) { throw new AssertionError("wrong overload"); }
      public String stats() { return "live metrics"; }`);
    assert.notEqual(code, base);
    writeFileSync(source, code);
    const result = checkJava(source, { javac, java, classpath, ...acceptanceTest('CASE-016') });
    assert.equal(result.compile.status, 'ok', result.compile.detail);
    assert.equal(result.tests.status, 'ok', result.tests.detail);
  }));
  it('executes Micrometer counters and percentile timers with their runtime dependencies', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const test = join(dir, 'MetricsTest.java');
    writeFileSync(source, 'public class Example {}');
    writeFileSync(test, `import io.micrometer.core.instrument.*;
      import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
      import java.util.concurrent.TimeUnit;
      class MetricsTest { public static void main(String[] args) throws Exception {
        var registry = new SimpleMeterRegistry();
        try {
          Counter counter = registry.counter("requests"); counter.increment();
          Timer timer = Timer.builder("latency").publishPercentiles(0.5).register(registry);
          timer.record(5, TimeUnit.MILLISECONDS);
          if (counter.count() != 1 || timer.count() != 1) throw new AssertionError("Missing metrics");
          Class.forName("org.HdrHistogram.Histogram");
          Class.forName("org.LatencyUtils.PauseDetector");
        } finally { registry.close(); }
      } }`);
    const result = checkJava(source, { javac, java, classpath, testSource: test, testClass: 'MetricsTest' });
    assert.equal(result.compile.status, 'ok', result.compile.detail);
    assert.equal(result.tests.status, 'ok', result.tests.detail);
  }));
  it('detects a real tenant-context leak through the public sync method', { skip: (!hasJdk || !classpath) && 'JDK/dependency classpath unavailable' }, () => temporary(dir => {
    const source = join(dir, 'input.java');
    const leaky = readFileSync(join(REPOSITORY_ROOT, 'cases', 'CASE-002-threadlocal-and-future', 'before.java'), 'utf8');
    writeFileSync(source, leaky);
    const options = { javac, java, classpath, ...acceptanceTest('CASE-002') };
    const fail = checkJava(source, options);
    assert.equal(fail.compile.status, 'ok', fail.compile.detail);
    assert.equal(fail.tests.status, 'failed', fail.tests.detail);
    writeFileSync(source, leaky.replace('syncRemote(order);', 'try { syncRemote(order); } finally { TENANT.remove(); }'));
    const pass = checkJava(source, options);
    assert.equal(pass.tests.status, 'ok', pass.tests.detail);
  }));
  it('rejects a quote implementation that waits synchronously before returning its future', { skip: !hasJdk && 'JDK unavailable' }, () => temporary(dir => {
    const file = join(dir, 'input.java');
    const source = `import java.util.concurrent.*;
      public class QuoteService {
        private final ThreadPoolExecutor pool = new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(8));
        public CompletableFuture<String> quote(String id) {
          CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> "quote-" + id, pool).orTimeout(200,TimeUnit.MILLISECONDS);
          return future;
        }
      }`;
    writeFileSync(file, source);
    const options = { javac, java, ...acceptanceTest('CASE-012') };
    const good = checkJava(file, options);
    assert.equal(good.tests.status, 'ok', good.tests.detail);
    writeFileSync(file, source.replace('return future;', 'try { future.get(); } catch (Exception e) {} return future;'));
    const bad = checkJava(file, options);
    assert.equal(bad.compile.status, 'ok', bad.compile.detail);
    assert.equal(bad.tests.status, 'failed');
  }));
});

describe('experiment provenance', () => {
  it('scopes test adapters to the selected task instead of inventing unrelated business interfaces', () => {
    const quote = deliveryContract({ id: 'CASE-012' });
    for (const unrelated of ['TENANT', 'retryQueue', 'fallbackQueue', 'Order(', 'orderNotifier']) assert.equal(quote.includes(unrelated), false, unrelated);
    assert.match(quote, /SLF4J API\/Simple 2.0.17/);
    assert.match(deliveryContract({ id: 'CASE-002' }), /TENANT/);
    assert.match(deliveryContract({ id: 'CASE-008' }), /retryQueue/);
    assert.match(deliveryContract({ id: 'CASE-015' }), /fallbackQueue/);
    assert.equal(deliveryContract({ id: 'CASE-019' }).includes('orderNotifier'), false);
  });
  it('resumes recorded calls without generating them twice', () => temporary(dir => {
    const counter = join(dir, 'counter');
    const provider = join(dir, 'provider.cjs');
    writeFileSync(provider, `const fs=require('node:fs');const path=${JSON.stringify(counter)};
      const n=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8'))+1:1;fs.writeFileSync(path,String(n));
      const request=JSON.parse(fs.readFileSync(0,'utf8'));if(n===2)process.exit(7);
      process.stdout.write(JSON.stringify({model:request.model,code:'public class Example {}'}));`);
    const file = join(dir, 'config.json');
    const config = { model: 'test-provider-not-a-model-run', command: process.execPath, args: [provider], seed: 42,
      temperature: 0, maxOutputTokens: 4096, maxCalls: 3, timeoutMs: 1000, tokenBudget: 1200, topK: 5,
      caseIds: ['CASE-012'], java: { javac: join(dir, 'missing-compiler') } };
    writeFileSync(file, JSON.stringify(config));
    const out = join(dir, 'run');
    assert.throws(() => runExperiment(file, out), /incomplete/);
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.throws(() => runExperiment(file, out, false, true), /incomplete/);
    assert.equal(readFileSync(counter, 'utf8'), '3');
    writeFileSync(file, JSON.stringify({ ...config, temperature: 1 }));
    assert.throws(() => runExperiment(file, out, false, true), /Resume refused/);
    assert.equal(readFileSync(counter, 'utf8'), '3');
  }));
  it('retains invalid model output and continues the other strategy slots', () => temporary(dir => {
    const file = join(dir, 'config.json');
    const provider = join(dir, 'provider.cjs');
    const raw = 'Explanation\n```java\npublic class A {}\n```';
    writeFileSync(provider, `const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({model:r.model,code:${JSON.stringify(raw)}}));`);
    writeFileSync(file, JSON.stringify({ model: 'test-provider-not-a-model-run', command: process.execPath, args: [provider],
      seed: 42, temperature: 0, maxOutputTokens: 4096, maxCalls: 3, timeoutMs: 1000, tokenBudget: 1200, topK: 5, caseIds: ['CASE-012'] }));
    const out = join(dir, 'run');
    assert.throws(() => runExperiment(file, out), /incomplete/);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as { agent: Array<{ output: string }> };
    assert.equal(report.agent.length, 3);
    assert.ok(report.agent.every(item => item.output === 'invalid'));
  }));
  it('preserves usage and raw responses when a model generation is truncated', () => temporary(dir => {
    const provider = join(dir, 'provider.cjs'); const file = join(dir, 'config.json');
    writeFileSync(provider, `const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({model:r.model,code:'',finish_reason:'length',usage:{total_tokens:50},raw_response:{choices:[],usage:{total_tokens:50}}}));`);
    writeFileSync(file, JSON.stringify({ model: 'test-provider-not-a-model-run', command: process.execPath, args: [provider],
      seed: 42, temperature: 0, maxOutputTokens: 4096, maxCalls: 3, timeoutMs: 1000, tokenBudget: 1200, topK: 5, caseIds: ['CASE-012'] }));
    const out = join(dir, 'run');
    assert.throws(() => runExperiment(file, out), /incomplete/);
    const call = JSON.parse(readFileSync(join(out, 'calls/rules/CASE-012.json'), 'utf8')) as { status: string; usage: { total_tokens: number } };
    assert.equal(call.status, 'invalid_output'); assert.equal(call.usage.total_tokens, 50);
    assert.ok(readFileSync(join(out, 'raw-responses/rules/CASE-012.json'), 'utf8').includes('total_tokens'));
  }));
  it('accepts API roots, v1 bases and complete chat-completions endpoints', () => {
    assert.equal(chatEndpoint('https://api.deepseek.com').href, 'https://api.deepseek.com/chat/completions');
    assert.equal(chatEndpoint('https://api.deepseek.com/v1/').href, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(chatEndpoint('https://api.deepseek.com/chat/completions').pathname, '/chat/completions');
    assert.throws(() => chatEndpoint('not-a-url'), /Value omitted/);
    assert.throws(() => chatEndpoint('http://api.deepseek.com'), /HTTPS/);
  });
  it('omits unsupported DeepSeek seed parameters while preserving request limits', () => {
    const request = { model: 'deepseek-chat', prompt: 'java task', seed: 42, temperature: 0, maxOutputTokens: 8192 };
    const deepseek = providerParameters(new URL('https://api.deepseek.com/chat/completions'), request);
    assert.equal('seed' in deepseek, false);
    assert.equal(deepseek['max_tokens'], 8192);
    assert.equal(deepseek['temperature'], 0);
    assert.deepEqual(deepseek['thinking'], { type: 'disabled' });
    assert.equal(providerParameters(new URL('https://example.org/chat/completions'), request)['seed'], 42);
  });
  it('validates limits and prepares 63 prompts without invoking a provider or overwriting a run', () => temporary(dir => {
    const config = { model: 'specified-model', command: '/nonexistent/provider', args: [], seed: 42, temperature: 0,
      maxOutputTokens: 4096, maxCalls: 63, timeoutMs: 1000, tokenBudget: 1200, topK: 5 };
    assert.throws(() => validateExperimentConfig({ ...config, maxCalls: 0 }));
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify(config));
    const out = join(dir, 'run');
    runExperiment(configFile, out, true);
    const manifest = JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8')) as { planned_calls: number; jobs: unknown[] };
    assert.equal(manifest.planned_calls, 63);
    assert.equal(manifest.jobs.length, 63);
    assert.throws(() => runExperiment(configFile, out, true), /fresh experiment directory/);
  }));
  it('prepares exactly three pilot jobs and rejects unknown or duplicate case selections', () => temporary(dir => {
    const config = { model: 'specified-model', command: '/nonexistent/provider', args: [], seed: 42, temperature: 0,
      maxOutputTokens: 4096, maxCalls: 3, timeoutMs: 1000, tokenBudget: 1200, topK: 5, caseIds: ['CASE-012'] };
    assert.throws(() => validateExperimentConfig({ ...config, caseIds: ['CASE-012', 'CASE-012'] }), /unique/);
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(config));
    const out = join(dir, 'pilot');
    runExperiment(file, out, true);
    const manifest = JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8')) as { planned_calls: number; jobs: Array<{ case_id: string; strategy: string }> };
    assert.equal(manifest.planned_calls, 3);
    assert.deepEqual(manifest.jobs.map(j => j.case_id), ['CASE-012', 'CASE-012', 'CASE-012']);
    assert.deepEqual(manifest.jobs.map(j => j.strategy), ['baseline', 'rag', 'rules']);
    writeFileSync(file, JSON.stringify({ ...config, caseIds: ['CASE-012', 'CASE-999'] }));
    assert.throws(() => runExperiment(file, join(dir, 'bad'), true), /未知的用例/);
    const report = runEvaluation({ casesDir: join(REPOSITORY_ROOT, 'cases'), outputDir: out, caseIds: ['CASE-012'], evaluateAgentResults: true });
    assert.equal(report.case_count, 1);
    assert.equal(report.agent.length, 3);
  }));
  it('runs only selected strategies in an explicitly scoped retest', () => temporary(dir => {
    const config = { model: 'test-provider', command: process.execPath, args: ['-e',
      'process.stdout.write(JSON.stringify({model:"test-provider",code:"public class Example {}"}))'],
      seed: 42, temperature: 0, maxOutputTokens: 100, maxCalls: 1, timeoutMs: 1000,
      tokenBudget: 1200, topK: 5, caseIds: ['CASE-019'], strategies: ['rules'] as const };
    assert.throws(() => validateExperimentConfig({ ...config, strategies: [] }), /strategies/);
    assert.throws(() => validateExperimentConfig({ ...config, strategies: ['rules','rules'] }), /strategies/);
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(config));
    const out = join(dir, 'retest');
    runExperiment(file, out);
    const manifest = JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8'));
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(manifest.protocol, 5);
    assert.equal(manifest.planned_calls, 1);
    assert.equal(report.agent.length, 1);
    assert.equal(report.agent[0].strategy, 'rules');
  }));
  it('stops after a provider failure and retains missing cases in the report', () => temporary(dir => {
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ model: 'test-provider-not-a-model-run', command: process.execPath,
      args: ['-e', 'process.exit(7)'], seed: 42, temperature: 0, maxOutputTokens: 4096, maxCalls: 63,
      timeoutMs: 1000, tokenBudget: 1200, topK: 5 }));
    const out = join(dir, 'run');
    assert.throws(() => runExperiment(configFile, out), /Experiment incomplete/);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as { agent: Array<{ output: string }>; provenance: { controlled_experiment: boolean } };
    assert.equal(report.agent.length, 63);
    assert.ok(report.agent.every(item => item.output === 'missing'));
    assert.equal(report.provenance.controlled_experiment, false);
  }));
  it('retains raw model output and records extraction before evaluating a fenced response', () => temporary(dir => {
    const raw = '```java\npublic class Example {}\n```';
    const marker = join(dir, 'called');
    const provider = join(dir, 'provider.cjs');
    writeFileSync(provider, 'const fs=require("node:fs"); const request=JSON.parse(fs.readFileSync(0,"utf8"));' +
      `if(fs.existsSync(${JSON.stringify(marker)})) process.exit(7); fs.writeFileSync(${JSON.stringify(marker)},"1");` +
      `process.stdout.write(JSON.stringify({model:request.model,code:${JSON.stringify(raw)},raw_response:{choices:[{message:{content:${JSON.stringify(raw)}}}]}}));`);
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ model: 'test-provider-not-a-model-run', command: process.execPath,
      args: [provider], seed: 42, temperature: 0, maxOutputTokens: 4096, maxCalls: 63, timeoutMs: 1000,
      tokenBudget: 1200, topK: 5, java: { javac: join(dir, 'missing-compiler') } }));
    const out = join(dir, 'run');
    assert.throws(() => runExperiment(configFile, out), /Experiment incomplete/);
    assert.equal(readFileSync(join(out, 'raw-responses/baseline/CASE-001.txt'), 'utf8'), raw);
    assert.equal(readFileSync(join(out, 'results/baseline/CASE-001.java'), 'utf8'), 'public class Example {}');
    const call = JSON.parse(readFileSync(join(out, 'calls/baseline/CASE-001.json'), 'utf8')) as { extraction: { raw_sha256: string; format: string } };
    assert.equal(call.extraction.format, 'single_fenced_block');
    assert.equal(call.extraction.raw_sha256, sha256(raw));
  }));
});
