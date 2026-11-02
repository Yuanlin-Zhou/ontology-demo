import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { RuleEngine } from '../src/api/engine.ts';
import { checkJava } from '../eval/java.ts';

const engine = RuleEngine.load();
const findings = (code: string, rule: string) => engine.validate({ code, ruleIds: [rule] }).violations;
const pool = 'new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2))';
const cancellation = (submit: string, cleanup: string, extra = '') => `import java.util.concurrent.*;
class A { ThreadPoolExecutor pool=${pool}; ${extra}
 void run()throws Exception { FutureTask<String> task=new FutureTask<>(()->"ok");
 ${submit} try{task.get(1,TimeUnit.SECONDS);}catch(TimeoutException e){task.cancel(true);${cleanup}} } }`;

describe('coverage review: cancellation queue identity', () => {
  it('detects the archived wrapper mismatch and cancelled queued task without removal', () => {
    for (const [experiment, strategy] of [['2026-10-27-63calls','rules'],['2026-11-02-observable-v2','rules']]) {
      const code=readFileSync(`eval/experiments/${experiment}/evidence/results/${strategy}/CASE-020.java`,'utf8');
      const result=engine.validate({code}).violations.filter(v=>v.rule_id==='TP-SUBMIT-002');
      assert.ok(result.some(v=>/入队/.test(v.message)));
      if(experiment==='2026-10-27-63calls')assert.ok(result.some(v=>/包装器/.test(v.message)));
    }
  });
  it('accepts direct remove and purge; does not accept another task or another pool', () => {
    const check=(cleanup:string)=>findings(cancellation('pool.execute(task);',cleanup,`ThreadPoolExecutor other=${pool};`),'TP-SUBMIT-002');
    assert.equal(check('pool.remove(task);').length,0);
    assert.equal(check('pool.purge();').length,0);
    assert.equal(check('').length,1);
    assert.equal(check('other.remove(task);').length,1);
    assert.equal(check('pool.remove(new FutureTask<>(()->"other"));').length,1);
    assert.equal(check('if(false)pool.remove(task);').length,1);
    assert.equal(check('Runnable later=()->pool.remove(task);').length,1);
  });
  it('tracks a stable wrapper alias; purge and removing the inner task do not remove a lambda', () => {
    const submit='Runnable queued=()->task.run();pool.execute(queued);';
    assert.equal(findings(cancellation(submit,'pool.remove(queued);'),'TP-SUBMIT-002').length,0);
    for(const cleanup of ['pool.remove(task);','pool.purge();'])assert.equal(findings(cancellation(submit,cleanup),'TP-SUBMIT-002').length,1);
  });
  it('accepts corresponding finally cleanup and stays within its documented executor/type scope', () => {
    const code=cancellation('pool.execute(task);','').replace('task.cancel(true);}', 'task.cancel(true);}finally{pool.remove(task);}');
    assert.equal(findings(code,'TP-SUBMIT-002').length,0);
    assert.equal(findings(cancellation('pool.execute(task);','').replace('task.cancel(true);','cancelElsewhere(task);'),'TP-SUBMIT-002').length,0);
    assert.equal(findings('class A {void f(CompletableFuture<?> f){f.cancel(true);}}','TP-SUBMIT-002').length,0);
  });
  it('does not report queue retention for an AbortPolicy-rejected submission that was never queued', () => {
    const code=`class A {ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2),new ThreadPoolExecutor.AbortPolicy());
      void f(){FutureTask<String> task=new FutureTask<>(()->"ok");try{pool.execute(task);}catch(RejectedExecutionException error){task.cancel(false);throw error;}}}`;
    assert.equal(findings(code,'TP-SUBMIT-002').length,0);
  });
});

describe('coverage review: shutdown pending tasks', () => {
  const check=(action:string)=>findings(`class A { void stop(ExecutorService pool) { ${action} } }`,'TP-SHUTDOWN-004');
  it('does not mistake an unread local assignment for processing pending work', () => {
    assert.equal(check('pool.shutdownNow();').length,1);
    assert.equal(check('List<Runnable> pending=pool.shutdownNow();').length,1);
    assert.equal(check('List<Runnable> pending=pool.shutdownNow();pending=null;').length,1);
    assert.equal(check('List<Runnable> pending=pool.shutdownNow();pending.forEach(this::compensate);').length,0);
    assert.equal(check('compensate(pool.shutdownNow());').length,0);
  });
  it('does not confuse local shadowing with consumption of the pending list', () => {
    assert.equal(check('List<Runnable> pending=pool.shutdownNow();Runnable later=()->{List<Runnable> pending=List.of();log(pending);};').length,1);
    // Escaping a list is not proof of compensation; the bounded checker leaves it for review.
    assert.equal(check('List<Runnable> pending=pool.shutdownNow();saveForReview(pending);').length,0);
  });
});

describe('coverage review: context explicit cleanup paths', () => {
  const check=(cleanup:string,setup='String previous=TENANT.get();')=>findings(`class A {
    ThreadLocal<String> TENANT=new ThreadLocal<>();
    void work(boolean condition){${setup}TENANT.set("new");try{business();}finally{${cleanup}}}
  }`,'TP-SUBMIT-004');
  it('recognizes restoring a stable captured value even without remove', () => {
    assert.equal(check('TENANT.set(previous);').length,0);
    assert.equal(check('if(previous==null)TENANT.remove();else TENANT.set(previous);').length,0);
    assert.equal(check('TENANT.set("unrelated");').length,1);
    assert.equal(check('TENANT.set(previous);','String previous=TENANT.get();previous="wrong";').length,1);
  });
  it('rejects deferred, conditional, early-return and overwritten cleanup', () => {
    for(const action of ['Runnable later=()->TENANT.remove();','if(condition)TENANT.remove();',
      'if(condition)return;TENANT.remove();','TENANT.remove();TENANT.set("leak");']) {
      assert.equal(check(action).length,1,action);
    }
    assert.equal(check('if(condition)TENANT.remove();else TENANT.set(previous);').length,0);
  });
  it('checks a private restore helper and does not accept deferred cleanup inside the helper', () => {
    const source=`class A {ThreadLocal<String> TENANT=new ThreadLocal<>();
      void work(){String previous=TENANT.get();TENANT.set("new");try{business();}finally{restore(previous);}}
      private void restore(String old){if(old==null)TENANT.remove();else TENANT.set(old);}}`;
    assert.equal(findings(source,'TP-SUBMIT-004').length,0);
    assert.equal(findings(source.replace('if(old==null)TENANT.remove();else TENANT.set(old);','Runnable later=()->TENANT.remove();'),'TP-SUBMIT-004').length,1);
  });
  it('compares safe restoration and missed deferred/conditional cleanup with real JVM state',
    { skip: !process.env['EVAL_JAVAC'] && 'JDK selector unavailable' }, () => {
      const dir=mkdtempSync(join(tmpdir(),'context-review-'));
      try {
        for (const [cleanup, expected, diagnostic] of [
          ['TENANT.set(previous);','before',false],
          ['Runnable later=()->TENANT.remove();','new',true],
          ['if(false)TENANT.remove();','new',true],
        ] as const) {
          const source=`class ContextProbe {
            static ThreadLocal<String> TENANT=new ThreadLocal<>();
            static void work(){String previous=TENANT.get();TENANT.set("new");try{}finally{${cleanup}}}
            public static void main(String[] args){TENANT.set("before");try{work();
              if(!"${expected}".equals(TENANT.get()))throw new AssertionError("Unexpected context: "+TENANT.get());}finally{TENANT.remove();}}}
          `;
          const file=join(dir,'ContextProbe.java');writeFileSync(file,source);
          assert.equal(findings(source,'TP-SUBMIT-004').length>0,diagnostic);
          const result=checkJava(file,{javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],testSource:file,testClass:'ContextProbe'});
          assert.equal(result.compile.status,'ok',result.compile.detail);
          assert.equal(result.tests.status,'ok',result.tests.detail);
        }
      }finally{rmSync(dir,{recursive:true,force:true});}
    });
});
