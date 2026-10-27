import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JavaSymbols } from '../src/analyzer/java-symbols.ts';
import { parseJava } from '../src/analyzer/java-parser.ts';
import { RuleEngine } from '../src/api/engine.ts';
import { RuleRepository } from '../src/matcher/rule-repository.ts';
import { matchRules } from '../src/matcher/rule-matcher.ts';
import { ruleContext, chunkContext } from '../src/retrieval/knowledge-payload.ts';
import { estimateTokens } from '../src/retrieval/token-estimator.ts';
import { validateCode } from '../src/validator/rule-validator.ts';
import { checkJava } from '../eval/java.ts';

const engine = RuleEngine.load();
const imports = 'import java.util.concurrent.*;';
const pool = 'new ThreadPoolExecutor(1,2,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(10),r -> new Thread(r,"work"),new ThreadPoolExecutor.AbortPolicy())';
const violations = (code: string, rule: string) => engine.validate({ code: imports + code, ruleIds: [rule] }).violations;

describe('engine pipeline: scoped semantic evidence', () => {
  it('tracks synchronous interrupt restoration through catch and its own finally without accepting unprotected paths', () => {
    const code=`class A { void f(boolean condition) {
      boolean interrupted=false;
      try {throw new InterruptedException();}
      catch(InterruptedException ex){interrupted=true;System.err.println(ex);}
      finally{if(interrupted){Thread.currentThread().interrupt();}}
    } }`;
    const check=(s:string)=>violations(s,'TP-SHUTDOWN-003').length;
    assert.equal(check(code),0);
    assert.equal(check(code.replace('interrupted=true;','if(condition)interrupted=true;')),1);
    assert.equal(check(code.replace('interrupted=true;','return;interrupted=true;')),1);
    assert.equal(check(code.replace('interrupted=true;','interrupted=false;')),1);
    assert.equal(check(code.replace('if(interrupted){','interrupted=false;if(interrupted){')),1);
    assert.equal(check(code.replace('if(interrupted){','if(!interrupted){')),1);
    assert.equal(check(code.replace('if(interrupted){','if(condition){')),1);
    assert.equal(check(code.replace('interrupted=true;','Runnable later=()->{Thread.currentThread().interrupt();};')),1);
    assert.equal(check(code.replace('Thread.currentThread().interrupt();','Runnable later=()->Thread.currentThread().interrupt();')),1);
    assert.equal(check(code.replace('Thread.currentThread().interrupt();','new Thread(()->Thread.currentThread().interrupt());')),1);
    assert.equal(check(code.replace('interrupted=true;','if(condition)interrupted=true;else interrupted=true;')),0);
    assert.equal(check(code.replace('if(interrupted){','{')),0);
    assert.equal(check(code.replace('Thread.currentThread().interrupt();','Thread.currentThread().interrupt();Thread.interrupted();')),1);
    assert.equal(check(code.replace('interrupted=true;','if(condition){Thread.currentThread().interrupt();}else{interrupted=true;}')),0);
    assert.equal(check(code.replace('interrupted=true;','if(condition){return;}interrupted=true;')),1);
    assert.equal(check(code.replace('interrupted=true;','boolean different=true;')),1);
  });
  it('requires direct catch restoration on all explicit paths and respects finally overriding rethrow', () => {
    const code='class A {void f(boolean c)throws InterruptedException{try{throw new InterruptedException();}catch(InterruptedException e){ACTION}FINALLY}}';
    const check=(action:string,final='')=>violations(code.replace('ACTION',action).replace('FINALLY',final),'TP-SHUTDOWN-003').length;
    assert.equal(check('throw e;'),0);
    assert.equal(check('throw e;','finally{return;}'),1);
    assert.equal(check('throw e;','finally{throw new IllegalStateException();}'),1);
    assert.equal(check('throw e;','finally{Thread.currentThread().interrupt();}'),0);
    assert.equal(check('if(c)Thread.currentThread().interrupt();'),1);
    assert.equal(check('if(c)Thread.currentThread().interrupt();else throw e;'),0);
    assert.equal(check('Runnable later=()->Thread.currentThread().interrupt();'),1);
    assert.equal(check('Runnable later=()->{throw new IllegalStateException(e);};'),1);
    assert.equal(check('if(c)return;Thread.currentThread().interrupt();'),1);
    assert.equal(check('','finally{if(c)Thread.currentThread().interrupt();}'),1);
    assert.equal(check('Thread.currentThread().interrupt();Thread.interrupted();'),1);
    const nested='Thread.currentThread().interrupt();try{Thread.sleep(1);}catch(InterruptedException nested){Thread.currentThread().interrupt();}';
    assert.equal(check(nested),0);
    // Both the nested catch and its enclosing catch lose the second interruption.
    assert.equal(check(nested.replace('nested){Thread.currentThread().interrupt();}','nested){}')),2);
    assert.equal(check(nested+'try{}finally{Thread.interrupted();}'),1);
    assert.equal(check('for(int i=0;i<2;i++){System.err.println(i);}Thread.currentThread().interrupt();'),0);
    assert.equal(check('for(int i=0;i<2;i++){Thread.currentThread().interrupt();}'),1);
    assert.equal(check('for(int i=0;i<2;i++){if(c)return;}Thread.currentThread().interrupt();'),1);
  });

  it('binds a final pool initialized by alternative constructors to the same private factory without borrowing another resource', () => {
    const code=imports+`class A { final ThreadPoolExecutor p;
      A(){p=create();} A(int n){p=create();}
      private static ThreadPoolExecutor create(){ThreadPoolExecutor x=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));return x;}
      void stop(){p.shutdown();} }`;
    const check=(source:string)=>engine.validate({code:source,ruleIds:['TP-SHUTDOWN-001']}).violations;
    assert.equal(check(code).length,0);
    assert.equal(check(code.replace('A(int n){p=create();}','A(int n){p=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));}')).length,2);
    const origin=(source:string)=>{const symbols=new JavaSymbols(parseJava(source).rootNode);const call=symbols.nodes.find(n=>n.type==='method_invocation'&&n.childForFieldName('name')?.text==='shutdown')!;return symbols.origin(call.childForFieldName('object'));};
    assert.ok(origin(code));
    assert.equal(origin(code.replace('A(int n){p=create();}','A(int n){p=create();} void reset(){p=create();}')),undefined);
    assert.equal(origin(code.replace('A(int n){p=create();}','A(int n){Runnable later=()->{p=create();};}')),undefined);
  });

  it('requires a runtime exception guard inside recurring tasks, independent of submission catch or thread handlers', () => {
    const code=imports+`class A { ScheduledThreadPoolExecutor p=new ScheduledThreadPoolExecutor(1);
      void start(){try{p.scheduleWithFixedDelay(()->retry(),0,1,TimeUnit.SECONDS);}catch(Exception e){}}
      private void retry(){work();} private void work(){} }`;
    const check=(source:string)=>engine.validate({code:source,ruleIds:['TP-SUBMIT-005']}).violations;
    assert.equal(check(code).length,1);
    assert.equal(check(code.replace('new ScheduledThreadPoolExecutor(1)','new ScheduledThreadPoolExecutor(1,r->{Thread t=new Thread(r);t.setUncaughtExceptionHandler((thread,error)->System.err.println(error));return t;})')).length,1);
    assert.equal(check(code.replace('p.scheduleWithFixedDelay(()->retry(),0,1,TimeUnit.SECONDS)','p.schedule(()->retry(),0,TimeUnit.SECONDS)')).length,0);
    const safe=code.replace('()->retry()','()->{try{retry();}catch(RuntimeException e){System.err.println(e);}}');
    assert.equal(check(safe).length,0);
    assert.equal(check(safe.replace('catch(RuntimeException e)','catch(IllegalArgumentException e)')).length,1);
    assert.equal(check(safe.replace('System.err.println(e);','throw e;')).length,1);
    assert.equal(check(safe.replace('()->{try{retry();}', '()->{work();try{retry();}')).length,1);
    assert.equal(check(code.replace('private void retry(){work();}','private void retry(){try{work();}catch(RuntimeException e){System.err.println(e);}}')).length,0);
    const helper=code.replace('private void retry(){work();}','private void retry(int n){try{work();}catch(RuntimeException e){System.err.println(e);}} private int risky(){throw new IllegalStateException();}');
    assert.equal(check(helper.replace('()->retry()','()->retry(risky())')).length,1);
    assert.equal(check(helper.replace('()->retry()','()->retry(1)')).length,0);
    assert.equal(check(code.replace('()->retry()', '()->{Runnable unrelated=()->{try{retry();}catch(RuntimeException e){}};retry();}')).length,1);
    assert.equal(check(safe.replace('scheduleWithFixedDelay','scheduleAtFixedRate')).length,0);
    assert.equal(check(code.replace('scheduleWithFixedDelay','scheduleAtFixedRate')).length,1);
    const alias=safe.replace('p.scheduleWithFixedDelay(()->{try{retry();}catch(RuntimeException e){System.err.println(e);}},','Runnable task=()->{try{retry();}catch(RuntimeException e){System.err.println(e);}};p.scheduleWithFixedDelay(task,');
    assert.equal(check(alias).length,0);
    assert.equal(check('class Business {void scheduleWithFixedDelay(Runnable r,int a,int b,Object c){}} class A {Business p;void f(){p.scheduleWithFixedDelay(()->{},0,1,null);}}').length,0);
  });

  it('detects synchronous CompletableFuture composition without requiring an Async executor', () => {
    const sync=imports+'class A { void f(){CompletableFuture<String> result=new CompletableFuture<>();result.thenApply(v->v).whenComplete((v,e)->{});result.complete("done");} }';
    const facts=engine.analyze({code:sync});
    assert.ok(facts.featureIds.includes('THREAD_POOL.COMPLETABLE_FUTURE'));
    assert.equal(engine.validate({code:sync,ruleIds:['TP-SUBMIT-003']}).violations.length,0);
    assert.equal(engine.validate({code:sync.replace('thenApply(v','thenApplyAsync(v'),ruleIds:['TP-SUBMIT-003']}).violations.length,1);
    const unrelated='class CompletableFutureView { void thenApply(){} } class A { CompletableFutureView view; void f(){view.thenApply();} }';
    assert.ok(!engine.analyze({code:unrelated}).featureIds.includes('THREAD_POOL.COMPLETABLE_FUTURE'));
  });
  it('recognises a private shutdown wait helper without borrowing another pool or deferred work', () => {
    const code=imports+`class A { final ThreadPoolExecutor p=${pool}; final ThreadPoolExecutor q=${pool};
      void stop(){ p.shutdown(); waitForPool(); }
      private void waitForPool(){ try { p.awaitTermination(1,TimeUnit.SECONDS); }
        catch(InterruptedException e){Thread.currentThread().interrupt();} }
    }`;
    const check=(source: string)=>engine.validate({code:source,ruleIds:['TP-SHUTDOWN-002']}).violations;
    assert.equal(check(code).length,0);
    assert.equal(check(code.replace('p.awaitTermination','q.awaitTermination')).length,1);
    assert.equal(check(code.replace('private void waitForPool','public void waitForPool')).length,1);
    assert.equal(check(code.replace('p.shutdown(); waitForPool();','waitForPool(); p.shutdown();')).length,1);
    assert.equal(check(code.replace('p.shutdown(); waitForPool();','p.shutdown(); Runnable deferred=()->waitForPool();')).length,1);
    assert.equal(check(code.replace('private void waitForPool(){','private void waitForPool(int n){} private void waitForPool(){')).length,1);
    assert.equal(check(code.replace('try { p.awaitTermination(1,TimeUnit.SECONDS); }',
      'Runnable deferred=()->{try { p.awaitTermination(1,TimeUnit.SECONDS); }').replace('Thread.currentThread().interrupt();} }',
      'Thread.currentThread().interrupt();}}; }')).length,1);
  });
  it('ignores unrelated submit/execute/shutdown APIs and executor-like variable names', () => {
    const code = `class Business { void f() { var pool = new Business(); pool.execute(); pool.shutdown(); } void execute() {} void shutdown() {} }`;
    assert.deepEqual(engine.analyze({ code }).featureIds, []);
    assert.deepEqual(engine.validate({ code }).violations, []);
  });
  it('does not invent thread semantics from same-named business APIs or classify every per-task executor as virtual', () => {
    const unrelated='class A { void f(){ Business.ofVirtual(); Business.withInitial(); } }';
    assert.deepEqual(engine.analyze({code:unrelated}).featureIds,[]);
    const platform=engine.analyze({code:imports+'class A { ExecutorService p=Executors.newThreadPerTaskExecutor(r->new Thread(r)); }'});
    assert.equal(platform.model.pools[0]?.kind,'thread_per_task_executor');assert.ok(!platform.featureIds.includes('VIRTUAL_THREAD'));
    assert.equal(violations('class A { ExecutorService p=Executors.newFixedThreadPool(2,r->new Thread(r,"work")); }','TP-CREATE-003').length,0);
  });
  it('does not count configuration or isShutdown as runtime monitoring', () => {
    const code=`class A { ThreadPoolExecutor p=${pool}; boolean state(){return p.isShutdown();} }`;
    assert.equal(violations(code,'TP-MONITOR-001').length,1);
  });
  it('registers every declarator and does not duplicate expression factories', () => {
    const code = imports + 'class A { ExecutorService a=Executors.newFixedThreadPool(1), b=Executors.newFixedThreadPool(2); void f(){ use(Executors.newFixedThreadPool(3)); } }';
    assert.equal(engine.analyze({ code }).model.pools.length, 3);
  });
  it('does not treat a pool created later inside a Bean lambda as a container-owned pool', () => {
    const code=imports+'import org.springframework.context.annotation.Bean; class A { @Bean Executor runner(){return task -> {ExecutorService temporary=Executors.newFixedThreadPool(1); temporary.execute(task);};} }';
    assert.equal(engine.analyze({code}).model.pools[0]?.isBean,false);
    assert.equal(violations(code,'TP-CREATE-002').length,1);
  });
  it('retains Spring factory setters after promoting the returned pool to its field', () => {
    const code = `import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
      class A { private final ThreadPoolTaskExecutor owned = build();
        private static ThreadPoolTaskExecutor build() { ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
          executor.setCorePoolSize(2); executor.setMaxPoolSize(4); executor.setQueueCapacity(10);
          executor.setRejectedExecutionHandler(new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()); return executor; }
      }`;
    const fact = engine.analyze({ code }).model.pools[0]!;
    assert.equal(fact.variableName, 'owned');
    assert.equal(fact.queue?.capacity, 10);
    assert.equal(fact.rejection?.kind, 'abort');
    assert.equal(violations(code, 'TP-CONFIG-004').length, 0);
    assert.equal(violations(code, 'TP-REJECT-001').length, 0);
  });
  it('respects inferred lambda shadowing and does not mistake comments for rejection reporting', () => {
    const shadow=`class A { ThreadPoolExecutor executor=${pool}; void f(){java.util.function.Consumer<Business> c=executor -> executor.execute();} }`;
    const analysis=engine.analyze({code:imports+shadow+' class Business { void execute(){} }'});assert.equal(analysis.model.submits.length,0);
    const comment='class A implements RejectedExecutionHandler { public void rejectedExecution(Runnable r,ThreadPoolExecutor e){ /* logger.warn("rejected"); */ } }';
    assert.equal(violations(comment,'TP-REJECT-005').length,1);
  });
  it('does not combine same-named Spring locals from different methods', () => {
    const code = `import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
      class A { void first(){ ThreadPoolTaskExecutor executor=new ThreadPoolTaskExecutor(); executor.setQueueCapacity(7); }
        void second(){ ThreadPoolTaskExecutor executor=new ThreadPoolTaskExecutor(); executor.setQueueCapacity(19); } }`;
    assert.deepEqual(engine.analyze({ code }).model.pools.map(p => p.queue?.capacity), [7,19]);
  });
  it('resolves constant capacities and recognises symbolic bounded queue constructors', () => {
    const code = imports + `class A { static final int CAPACITY=12; final ThreadPoolExecutor p=new ThreadPoolExecutor(1,2,30,TimeUnit.SECONDS,new LinkedBlockingQueue<>(CAPACITY)); }`;
    assert.equal(engine.analyze({ code }).model.pools[0]?.queue?.capacity, 12);
    assert.equal(violations(code, 'TP-CONFIG-004').length, 0);
    assert.equal(violations(code.replace('CAPACITY));','Integer.MAX_VALUE));'), 'TP-CONFIG-004').length, 1);
  });
  it('checks each pool for monitoring instead of allowing one pool to cover another', () => {
    const code = `class A { ThreadPoolExecutor first=${pool}, second=${pool}; int stats(){ return first.getActiveCount(); } }`;
    const found = violations(code, 'TP-MONITOR-001');
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /second/);
  });
  it('binds rejection policy to the submitted pool', () => {
    const code = `class A { ThreadPoolExecutor first=${pool}, second=${pool.replace('AbortPolicy','CallerRunsPolicy')};
      void f(){ second.execute(() -> {}); } }`;
    assert.equal(violations(code, 'TP-REJECT-003').length, 0);
    assert.equal(violations(code.replace('second.execute', 'first.execute'), 'TP-REJECT-003').length, 1);
  });
  it('does not accept awaiting without initiating shutdown, or awaiting in an unrelated method', () => {
    const code = `class A { ThreadPoolExecutor p=${pool}; void waitOnly() throws Exception { p.awaitTermination(1,TimeUnit.SECONDS); } void stop(){p.shutdown();} }`;
    assert.equal(violations(code, 'TP-SHUTDOWN-002').length, 1);
    assert.equal(violations(code.replace('void stop(){p.shutdown();}', ''), 'TP-SHUTDOWN-001').length, 1);
  });
  it('recognises Java 21 close and Spring default destruction without forcing duplicate shutdown', () => {
    assert.equal(violations(`class A { ExecutorService p=Executors.newVirtualThreadPerTaskExecutor(); void close(){p.close();} }`, 'TP-SHUTDOWN-002').length, 0);
    const code = `import org.springframework.context.annotation.Bean; class A { @Bean public ExecutorService pool(){ return Executors.newVirtualThreadPerTaskExecutor(); } }`;
    assert.equal(violations(code, 'TP-CREATE-005').length, 0);
    assert.equal(violations(code, 'TP-SHUTDOWN-001').length, 0);
    assert.equal(violations(code.replace('@Bean ', '@Bean(destroyMethod="") '), 'TP-CREATE-005').length, 1);
  });
  it('does not confuse try around execute with a catch inside the asynchronous task', () => {
    const code = `class A { ThreadPoolExecutor p=${pool}; void f(){ try {p.execute(() -> {throw new IllegalStateException();});} catch(RuntimeException e){} } }`;
    assert.equal(violations(code, 'TP-SUBMIT-005').length, 1);
    const safe = code.replace('throw new IllegalStateException();', 'try {throw new IllegalStateException();} catch(RuntimeException e) {System.err.println(e);}');
    assert.equal(violations(safe, 'TP-SUBMIT-005').length, 0);
    const comment = code.replace('class A {','class A { /* setUncaughtExceptionHandler */');
    assert.equal(violations(comment, 'TP-SUBMIT-005').length, 1);
  });
  it('does not let a handler for another pool hide an uncaught task exception', () => {
    const factory = 'r -> { Thread t=new Thread(r); t.setUncaughtExceptionHandler((thread,error)->System.err.println(error)); return t; }';
    const code = `class A { ThreadPoolExecutor first=${pool.replace('r -> new Thread(r,"work")',factory)}, second=${pool};
      void f(){first.execute(() -> {throw new IllegalStateException();}); second.execute(() -> {throw new IllegalStateException();});} }`;
    const found=violations(code,'TP-SUBMIT-005'); assert.equal(found.length,1); assert.match(found[0]!.message,/second/);
  });
  it('does not treat storing an unused Future as consuming it or borrow a same-named Future from another method', () => {
    const code = `class A { ExecutorService p=Executors.newFixedThreadPool(1); void f(){Future<?> result=p.submit(() -> {});} void other(Future<?> result) throws Exception {result.get(1,TimeUnit.SECONDS);} }`;
    assert.equal(violations(code, 'TP-SUBMIT-001').length, 1);
    assert.equal(violations(code.replace('result=p.submit(() -> {});','result=p.submit(() -> {}); try { result.get(1,TimeUnit.SECONDS); } catch(Exception e){}'), 'TP-SUBMIT-001').length, 0);
  });
  it('handles binary CompletableFuture overloads and timeout-protected join', () => {
    const code=`class A { void f(CompletableFuture<String> first, CompletableFuture<String> second, Executor executor){ first.thenCombineAsync(second,(a,b)->a+b); } }`;
    assert.equal(violations(code,'TP-SUBMIT-003').length,1);
    assert.equal(violations(code.replace('(a,b)->a+b)', '(a,b)->a+b,executor)'), 'TP-SUBMIT-003').length,0);
    assert.equal(violations('class A { void f(CompletableFuture<?> f){f.orTimeout(1,TimeUnit.SECONDS).join();} }','TP-SUBMIT-002').length,0);
  });
  it('does not use cleanup in a different method to protect an unsafe ThreadLocal write', () => {
    const code='class A { static ThreadLocal<String> TENANT=new ThreadLocal<>(); void safe(){try{TENANT.set("safe");}finally{TENANT.remove();}} void unsafe(){TENANT.set("unsafe");} }';
    const found=violations(code,'TP-SUBMIT-004'); assert.equal(found.length,1); assert.match(found[0]!.snippet,/unsafe/);
  });
  it('follows private helper writes through protected callers and explains unprotected call sites', () => {
    const base='class A { static ThreadLocal<String> TENANT=new ThreadLocal<>(); private void validate(){TENANT.set("tenant");} void export(){try{validate();}finally{TENANT.remove();}} }';
    assert.equal(violations(base,'TP-SUBMIT-004').length,0);
    const before=base.replace('try{validate();}', 'validate();try{}');
    const found=violations(before,'TP-SUBMIT-004');assert.equal(found.length,1);assert.match(found[0]!.suggestion,/validate/);assert.match(found[0]!.suggestion,/移入/);
    const mixed=base.replace(' void export()', ' void unsafe(){validate();} void export()');
    assert.equal(violations(mixed,'TP-SUBMIT-004').length,1);
  });
  it('requires restoring the current thread or rethrowing the actual interrupted exception', () => {
    const base='class A { void f(Thread other){ try {throw new InterruptedException();} catch(InterruptedException ex){ other.interrupt(); throw new IllegalStateException(ex); } } }';
    assert.equal(violations(base,'TP-SHUTDOWN-003').length,1);
    assert.equal(violations(base.replace('other.interrupt()', 'Thread.currentThread().interrupt()'),'TP-SHUTDOWN-003').length,0);
  });
});

describe('engine pipeline: selection and validation contracts', () => {
  it('counts the actual serialized context, enforces zero/tiny budgets and reports omissions', () => {
    for (const budget of [0,1,100,600,1200]) {
      const result=engine.retrieve({code:imports+'class A { ExecutorService pool=Executors.newFixedThreadPool(2); }',tokenBudget:budget});
      assert.equal(result.stats.estimated_tokens,estimateTokens(ruleContext(result.rules)));
      assert.ok(result.stats.estimated_tokens<=budget);
      if (budget <= 600) assert.ok(result.selection!.dropped_rule_ids.length>0);
    }
    assert.throws(()=>engine.retrieve({code:'class A {}',tokenBudget:-1}),/nonnegative/);
    const prompt=engine.buildPrompt({task:'review',code:imports+'class A { ExecutorService p=Executors.newFixedThreadPool(1); }',strategy:'rules',tokenBudget:600});
    assert.ok(prompt.context_tokens<=600);
  });
  it('prioritises current violations over satisfied configuration within a small budget', () => {
    const code=imports+`class A { final ThreadPoolExecutor p=${pool}; void f(){p.submit(()->{});} }`;
    const result=engine.retrieve({code,tokenBudget:400});
    assert.ok(result.rules.some(r=>r.id==='TP-SHUTDOWN-001'));
    const violated=new Set(engine.validate({code}).violations.map(v=>v.rule_id));
    const firstSatisfied=result.rules.findIndex(r=>!violated.has(r.id));
    if(firstSatisfied>=0) assert.ok(result.rules.slice(firstSatisfied).every(r=>!violated.has(r.id)),
      'Satisfied rules may fill remaining space only after selected violations');
  });
  it('supports explicit planned features for new code without inventing detected evidence', () => {
    const result=engine.retrieve({code:'',featureHints:['THREAD_POOL.CREATE']});
    assert.ok(result.rules.length>0);assert.deepEqual(result.features,[]);assert.deepEqual(result.selection?.planned_features,['THREAD_POOL.CREATE']);
    assert.throws(()=>engine.retrieve({code:'',featureHints:['UNKNOWN']}),/Unknown planned feature/);
  });
  it('keeps RAG within the same serialized budget and excludes project/evaluation documents', () => {
    for(const budget of [0,1,200,600]) {
      const chunks=engine.retrieveChunks('线程池 队列 拒绝策略',{topK:10,tokenBudget:budget});
      assert.ok(estimateTokens(chunkContext(chunks))<=budget);
      assert.ok(chunks.every(c=>['java-thread-pool-summary.md','java-thread-pool-best-practices.md'].includes(c.source)));
    }
  });
  it('does not count absent checkers, advisory rules, invalid syntax or an explicit empty rule list as checked', () => {
    const rule=engine.rule('TP-CONFIG-004')!;
    const unavailable=validateCode([{...rule,check:{validator:'not.registered'}}],imports+`class A { ThreadPoolExecutor p=${pool}; }`);
    assert.deepEqual(unavailable.checked_rules,[]);assert.equal(unavailable.status,'partial');
    const {check,...advisory}=rule;
    assert.deepEqual(validateCode([advisory],imports+`class A { ThreadPoolExecutor p=${pool}; }`).checked_rules,[]);
    const invalid=engine.validate({code:'class Broken { void f( }',ruleIds:[rule.id]});
    assert.equal(invalid.status,'invalid');assert.deepEqual(invalid.checked_rules,[]);
    assert.deepEqual(engine.validate({code:imports+`class A { ThreadPoolExecutor p=${pool}; }`,ruleIds:[]}).checked_rules,[]);
  });
  it('makes CLI syntax failures nonzero and preserves retrieval limits in prompt format', () => {
    const dir=mkdtempSync(join(tmpdir(),'rules-cli-review-'));const file=join(dir,'A.java');
    try {
      writeFileSync(file,'class Broken { void f( }');
      const invalid=spawnSync(process.execPath,['src/cli/index.ts','validate','--file',file,'--format','json'],{encoding:'utf8'});
      assert.equal(invalid.status,2,invalid.stderr);assert.equal(JSON.parse(invalid.stdout).status,'invalid');
      writeFileSync(file,imports+'class A { ExecutorService p=Executors.newFixedThreadPool(1); }');
      const prompt=spawnSync(process.execPath,['src/cli/index.ts','retrieve','--file',file,'--max-rules','0','--format','prompt'],{encoding:'utf8'});
      assert.equal(prompt.status,0,prompt.stderr);assert.doesNotMatch(prompt.stdout,/Applicable Engineering Rules/);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('fails on missing/empty knowledge and malformed applicability instead of silently loading no constraints', () => {
    const dir=mkdtempSync(join(tmpdir(),'rules-review-'));
    try {
      assert.throws(()=>RuleRepository.load({knowledgeDir:dir}),/No YAML rules/);
      writeFileSync(join(dir,'bad.yaml'),'id: X\nname: x\ndomain: [java]\ndescription: x\ncontent: x\napplies_when:\n  feature: [THREAD_POOL.CREATE]');
      assert.throws(()=>RuleRepository.load({knowledgeDir:dir}),/unknown applies_when key/);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('makes rationale selection and conditional related advice explicit', () => {
    const bare=matchRules(engine.repository,['THREAD_POOL.CONFIG.REJECTION'],{includeRationale:false});
    assert.ok(bare.rules.every(r=>!r.rationale));
    const expanded=matchRules(engine.repository,['THREAD_POOL.CONFIG.REJECTION'],{includeRelated:true,includeRationale:true});
    assert.ok(expanded.rules.some(r=>r.via==='related'));
    assert.match(ruleContext(expanded.rules),/仅在实现涉及该场景时适用/);
  });
});

describe('engine pipeline: bounded repair', () => {
  it('does not recommend ThreadPoolExecutor getters on a virtual-thread ExecutorService', () => {
    const code='import java.util.concurrent.*; class A { final ExecutorService p=Executors.newVirtualThreadPerTaskExecutor(); }';
    const finding=engine.validate({code}).violations.find(v=>v.rule_id==='TP-MONITOR-001');
    assert.ok(finding);
    assert.match(finding.suggestion,/业务准入/);
    assert.doesNotMatch(finding.suggestion,/getActiveCount|getQueue|getCompletedTaskCount/);
  });
  it('repairs task rejection even when compilation, configured tests and rules pass', async () => {
    const result=await engine.repair({task:'preserve business behavior',code:'class A {}',
      verify:code=>({compile:'ok',tests:'ok',task:code.includes('repaired')?'ok':'failed',
        diagnostics:'noise\n'.repeat(5000)+'java.lang.AssertionError: priority ordering missing\n'+'at recursive stack\n'.repeat(1000)}),
      generate:({prompt})=>{assert.match(prompt,/完整任务验收：failed/);assert.match(prompt,/priority ordering missing/);return 'class A { int repaired; }';}});
    assert.equal(result.status,'passed');assert.equal(result.model_calls,1);
    const unknown=await engine.repair({task:'needs review',code:'class A {}',verify:()=>({compile:'ok',tests:'ok',task:'not_run'}),generate:()=>{throw new Error('must not invent a review');}});
    assert.equal(unknown.status,'unverified');assert.equal(unknown.model_calls,0);
  });
  it('gates success on compiler/business checks and does not claim unavailable checks passed', async () => {
    const result=await engine.repair({task:'keep API',code:'class A {}',verify:()=>({compile:'unavailable',tests:'not_run'}),generate:()=>{throw new Error('must not call');}});
    assert.equal(result.status,'unverified');assert.equal(result.model_calls,0);
  });
  it('stops within the configured budget and stops a repeated candidate',async()=>{
    const code='class Broken { void f( }';const verify=()=>({compile:'failed' as const,tests:'not_run' as const,diagnostics:'syntax failure'});
    const zero=await engine.repair({task:'repair',code,maxRepairs:0,verify,generate:()=>''}); assert.equal(zero.status,'failed');assert.equal(zero.model_calls,0);
    const repeated=await engine.repair({task:'repair',code,maxRepairs:2,verify,generate:()=>code}); assert.equal(repeated.status,'stalled');assert.equal(repeated.model_calls,1);
  });
  it('recomputes applicability after each edit and cannot stop at compilation alone',async()=>{
    const initial='class Broken { void f( }';
    const incomplete=imports+`class A { final ThreadPoolExecutor p=${pool}; }`;
    const complete=incomplete.replace(' }',' void stop() throws Exception {p.shutdown();p.awaitTermination(1,TimeUnit.SECONDS);} }');
    const result=await engine.repair({task:'repair executor',code:initial,maxRepairs:2,
      verify:()=>({compile:'ok',tests:'ok'}),generate:({attempt,prompt})=>{if(attempt===2)assert.match(prompt,/TP-SHUTDOWN-001/);return attempt===1?incomplete:complete;}});
    assert.equal(result.status,'passed');assert.equal(result.model_calls,2);
    assert.ok(result.attempts[1]?.validation.violations.some(v=>v.rule_id==='TP-SHUTDOWN-001'));
  });
  const javac=process.env['EVAL_JAVAC']??'javac';const java=process.env['EVAL_JAVA']??'java';
  it('feeds real javac diagnostics back and validates the repaired source again', {skip:spawnSync(javac,['-version']).status!==0&&'JDK unavailable'},async()=>{
    const dir=mkdtempSync(join(tmpdir(),'repair-javac-'));const file=join(dir,'Example.java');
    const acceptance=join(dir,'RepairAcceptance.java');
    writeFileSync(acceptance, `import java.util.concurrent.*; class RepairAcceptance { public static void main(String[] args) {
      ThreadPoolExecutor pool=new ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1));
      try { new Example().configure(pool); Thread thread=pool.getThreadFactory().newThread(()->{});
        if (thread.getUncaughtExceptionHandler()==null || pool.getMaximumPoolSize()!=1) throw new AssertionError();
      } finally {pool.shutdownNow();}
    }}`);
    const bad='public class Example { void configure(java.util.concurrent.ThreadPoolExecutor pool){pool.setUncaughtExceptionHandler((t,e)->{});} }';
    const good='public class Example { void configure(java.util.concurrent.ThreadPoolExecutor pool){pool.setThreadFactory(task->{Thread thread=new Thread(task);thread.setUncaughtExceptionHandler((t,e)->System.err.println(e));return thread;});} }';
    try {
      const result=await engine.repair({task:'Preserve configure API and set a real worker exception handler',code:bad,
        verify:code=>{writeFileSync(file,code);const checks=checkJava(file,{javac,java,testSource:acceptance,testClass:'RepairAcceptance'});return {compile:checks.compile.status,tests:checks.tests.status,diagnostics:checks.compile.detail+checks.tests.detail};},
        generate:({prompt,attempt})=>{assert.equal(attempt,1);assert.match(prompt,/cannot find symbol/);assert.match(prompt,/编译：failed/);return good;}});
      assert.equal(result.status,'passed');assert.equal(result.model_calls,1);assert.equal(result.attempts.length,2);
      assert.equal(result.attempts[0]?.verification.compile,'failed');assert.equal(result.attempts[1]?.verification.compile,'ok');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
