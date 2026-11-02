import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { KnowledgeTree } from '../src/knowledge/tree.ts';
import { buildGraph, assertFresh, saveGraph, loadGraph } from '../src/codegraph/graph.ts';
import { retrieveByTags } from '../src/tag-retrieval/retrieve.ts';
import { prepareEdits } from '../eval/tagged-edit/prepare.ts';
import { evaluateEdits } from '../eval/tagged-edit/evaluate.ts';
import { checkJava } from '../eval/java.ts';

const engine=RuleEngine.load();
const tree=KnowledgeTree.load(REPOSITORY_ROOT,engine.rules());
const base=`import java.util.concurrent.*;
class A {
  ThreadPoolExecutor pool=new ThreadPoolExecutor(1,2,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));
  ThreadLocal<String> context=new ThreadLocal<>();
  void send(String value){pool.execute(()->business(value));}
  void send(int value){}
  private void business(String value){}
  void unrelated(){context.set("tenant");}
}`;
const build=(code=base)=>buildGraph(engine,tree,'A.java',code);
const target=(graph:ReturnType<typeof build>,signature:string)=>graph.entities.find(e=>e.signature===signature)!.id;

describe('hierarchical knowledge and persistent entity tagging',()=>{
  it('loads decision and norm leaves, maps all existing rules and rejects malformed trees',()=>{
    assert.equal(tree.leaves.length,15);
    assert.equal(tree.leaf('tp.create.queue').kind,'decision');
    assert.equal(tree.leaf('tp.use.context').kind,'norm');
    assert.deepEqual(tree.path('tp.create.queue'),['线程池','创建与参数决策','任务队列选择决策']);
    assert.equal(new Set(tree.leaves.flatMap(l=>l.rule_ids!)).size,26);
    const raw=JSON.parse(readFileSync('knowledge-tree/thread-pool.json','utf8'));
    for(const mutate of [
      (v:typeof raw)=>{v.nodes[0].parent='tp.create';},
      (v:typeof raw)=>{v.nodes[3].rule_ids=['UNKNOWN'];},
      (v:typeof raw)=>{v.nodes[3].any_features=['UNKNOWN'];},
    ]){const copy=structuredClone(raw);mutate(copy);assert.throws(()=>new KnowledgeTree(copy,engine.rules(),REPOSITORY_ROOT));}
    assert.throws(()=>tree.leaf('tp.create'));
  });
  it('identifies overloads and fields; retrieves referenced field tags without unrelated method tags',()=>{
    const graph=build();const send=target(graph,'send(String)');
    assert.notEqual(send,target(graph,'send(int)'));
    assert.ok(graph.edges.some(e=>e.from===send&&e.kind==='uses'&&e.to.endsWith('field:pool')));
    assert.ok(graph.entities.find(e=>e.kind==='class')!.tags.some(t=>t.leaf==='tp.use.context'));
    const r=retrieveByTags(tree,graph,base,{entities:[send],tokenBudget:10000});
    assert.ok(r.selected_leaf_ids.includes('tp.create.queue'));
    assert.ok(!r.selected_leaf_ids.includes('tp.use.context'));
    assert.ok(!r.selected_leaf_ids.includes('tp.use.priority'));
    const tag=graph.entities.flatMap(e=>e.tags).find(t=>t.origin==='ast'&&t.leaf==='tp.create.queue')!;
    assert.ok(tag.feature&&tag.evidence&&tag.line>0&&tag.column>0&&tag.confidence);
    assert.ok(r.entities.length<graph.entities.length);
  });
  it('distinguishes interfaces and nested types; abstract methods require explicit knowledge evidence',()=>{
    const source='package demo; interface Sender {void send(String value);} class Outer{class Inner{void send(int value){}}}';
    const graph=build(source);
    assert.ok(graph.entities.some(e=>e.id==='A.java#demo.Sender'&&e.kind==='interface'));
    assert.ok(graph.entities.some(e=>e.id==='A.java#demo.Outer.Inner::send(int)'));
    const id='A.java#demo.Sender::send(String)';
    assert.deepEqual(retrieveByTags(tree,graph,source,{entities:[id]}).selected_leaf_ids,[]);
    const manual=buildGraph(engine,tree,'A.java',source,[{entity:id,leaf:'tp.use.result',reason:'接口约定由异步实现消费结果'}]);
    assert.equal(manual.entities.find(e=>e.id===id)!.tags[0]!.origin,'manual');
    assert.throws(()=>buildGraph(engine,tree,'A.java',source,[{entity:id,leaf:'tp.use.result',reason:''}]));
  });
  it('invalidates stale code and tree snapshots and replaces removed AST tags on re-index',()=>{
    const graph=build();const edited=base.replace('pool.execute(()->business(value));','business(value);');
    assert.throws(()=>assertFresh(graph,tree,edited),/Stale/);
    const next=build(edited);assert.equal(target(next,'send(String)'),target(graph,'send(String)'));
    const r=retrieveByTags(tree,next,edited,{entities:[target(next,'send(String)')]});
    assert.ok(!r.selected_leaf_ids.includes('tp.create.queue'));
    assert.throws(()=>assertFresh({...graph,tree_hash:'old'},tree,base),/Stale/);
    assert.throws(()=>assertFresh({...graph,tagger:0},tree,base),/Stale/);
    assert.throws(()=>buildGraph(engine,tree,'A.java','class A {broken('));
    assert.throws(()=>buildGraph(engine,tree,'../outside.java',base));
  });
  it('retrieves planned new capabilities without pretending they already exist in code',()=>{
    const source=readFileSync('eval/tagged-edit/cases/EventPublisher.java','utf8');
    const graph=build(source);const id=target(graph,'publish(String)');
    assert.deepEqual(retrieveByTags(tree,graph,source,{entities:[id]}).selected_leaf_ids,[]);
    const planned=[{leaf:'tp.create.queue',reason:'新增异步缓冲'}];
    const r=retrieveByTags(tree,graph,source,{entities:[id],planned});
    assert.deepEqual(r.selected_leaf_ids,['tp.create.queue']);
    assert.equal(r.provenance['tp.create.queue']![0]!.via,'planned');
    assert.ok(!graph.entities.flatMap(e=>e.tags).some(t=>t.leaf==='tp.create.queue'));
    const zero=retrieveByTags(tree,graph,source,{entities:[id],planned,tokenBudget:0});
    assert.equal(zero.context,'');assert.deepEqual(zero.dropped_leaf_ids,['tp.create.queue']);
    assert.throws(()=>retrieveByTags(tree,graph,source,{entities:['unknown']}));
    assert.throws(()=>retrieveByTags(tree,graph,source,{entities:[id],planned:[{leaf:'tp',reason:'x'}]}));
  });
  it('persists tag evidence and enforces the full serialized knowledge budget',()=>{
    const directory=mkdtempSync(join(tmpdir(),'entity-graph-'));
    try{
      const graph=build();const path=join(directory,'graph.json');saveGraph(path,graph);assert.deepEqual(loadGraph(path),graph);
      for(const budget of [0,1,100,600,1200]) {
        const r=retrieveByTags(tree,graph,base,{entities:[target(graph,'send(String)')],tokenBudget:budget});
        assert.ok(r.estimated_tokens<=budget);
      }
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});

describe('tagged code edit experiment preparation',()=>{
  it('prepares paired prompts with identical edit inputs, budgets and facts, without model requests',()=>{
    const directory=mkdtempSync(join(tmpdir(),'edit-prepare-'));const output=join(directory,'run');
    try{
      const result=prepareEdits('eval/tagged-edit/suite.json',output);
      assert.equal(result.model_requests,0);assert.equal(result.quality_results,null);assert.equal(result.jobs.length,9);
      assert.ok(existsSync(join(output,'graphs','EDIT-QUEUE.json')));
      for(const id of ['EDIT-QUEUE','EDIT-ASYNC','EDIT-CONTEXT']) {
        const jobs=result.jobs.filter(j=>j.case_id===id);
        assert.equal(new Set(jobs.map(j=>j.source_hash)).size,1);assert.equal(new Set(jobs.map(j=>j.common_task_hash)).size,1);
        assert.ok(jobs.every(j=>j.knowledge_tokens_estimated<=1200&&j.status==='prepared_not_requested'));
      }
      const report=evaluateEdits(output,join(directory,'report.json'));
      assert.equal(report.present,0);assert.equal(report.controlled_model_comparison,false);
      assert.ok(report.records.every(r=>r.compile==='not_run'&&r.usage===null));
      assert.throws(()=>prepareEdits('eval/tagged-edit/suite.json',output),/fresh/);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('starts from complete compilable Java code rather than generation scaffolds',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},()=>{
      for(const file of ['BufferedNotifier','EventPublisher','TenantJob']) {
        const result=checkJava(resolve('eval/tagged-edit/cases',file+'.java'),{javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA']});
        assert.equal(result.compile.status,'ok',result.compile.detail);
      }
    });
  it('checks reference edits and detects unchanged code and broken worker restoration with real Java',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},()=>{
      const options={javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],testSource:resolve('eval/tagged-edit/AcceptanceTest.java'),testClass:'AcceptanceTest'};
      for(const [name,id]of [['BufferedNotifier','EDIT-QUEUE'],['EventPublisher','EDIT-ASYNC'],['TenantJob','EDIT-CONTEXT']]) {
        const good=checkJava(resolve('eval/tagged-edit/references',name+'.java'),{...options,testArgs:[id!]});
        assert.equal(good.compile.status,'ok',good.compile.detail);assert.equal(good.tests.status,'ok',good.tests.detail);
        const bad=checkJava(resolve('eval/tagged-edit/cases',name+'.java'),{...options,testArgs:[id!]});
        assert.equal(bad.compile.status,'ok',bad.compile.detail);assert.equal(bad.tests.status,'failed',bad.tests.detail);
      }
      const directory=mkdtempSync(join(tmpdir(),'edit-context-mutant-'));
      try{
        const file=join(directory,'TenantJob.java');
        writeFileSync(file,readFileSync('eval/tagged-edit/references/TenantJob.java','utf8').replace('finally{restore(previous);}','finally{}'));
        const mutant=checkJava(file,{...options,testArgs:['EDIT-CONTEXT']});
        assert.equal(mutant.compile.status,'ok',mutant.compile.detail);
        assert.equal(mutant.tests.status,'failed');assert.match(mutant.tests.detail,/Worker context leaked/);
      }finally{rmSync(directory,{recursive:true,force:true});}
    });
});
