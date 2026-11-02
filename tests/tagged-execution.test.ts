import { strict as assert } from 'node:assert';
import { describe,it } from 'node:test';
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEdits } from '../eval/tagged-edit/prepare.ts';
import { runTaggedEdits, type ProviderReply } from '../eval/tagged-edit/run.ts';
import { evaluateEdits } from '../eval/tagged-edit/evaluate.ts';

const source=readFileSync('eval/tagged-edit/references/BufferedNotifier.java','utf8');
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'tagged-execute-'));
  const suite=JSON.parse(readFileSync('eval/tagged-edit/suite.json','utf8'));suite.cases=suite.cases.slice(0,1);
  const config=join(root,'suite.json');writeFileSync(config,JSON.stringify(suite));
  const prepared=join(root,'prepared'),output=join(root,'run');prepareEdits(config,prepared);
  return {root,prepared,output,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
function reply():ProviderReply {
  return {model:'deepseek-flash',code:'```java\n'+source+'\n```',finish_reason:'stop',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30},
    raw_response:{model:'deepseek-flash',choices:[]},applied_parameters:{temperature:0,max_tokens:8192,seed:null,thinking:{type:'disabled'},
      endpoint:'https://api.deepseek.com/chat/completions',api_key_env:'EVAL_API_KEY'}};
}
describe('recorded entity-tag edit execution',()=>{
  it('rejects incomplete/extra budgets and changed prompts even if their manifest hash is edited',async()=>{
    const f=fixture();let calls=0;
    try{
      const provider=async()=>{calls++;return reply();};
      await assert.rejects(()=>runTaggedEdits(f.prepared,f.output,{maxCalls:2,provider}),/maxCalls/);
      await assert.rejects(()=>runTaggedEdits(f.prepared,f.output,{maxCalls:4,provider}),/maxCalls/);
      const manifest=JSON.parse(readFileSync(join(f.prepared,'manifest.json'),'utf8'));
      const file=join(f.prepared,manifest.jobs[0].prompt_file);writeFileSync(file,readFileSync(file,'utf8')+'\nchanged');
      manifest.jobs[0].prompt_hash='rehash-does-not-authorize-a-different-prompt';writeFileSync(join(f.prepared,'manifest.json'),JSON.stringify(manifest));
      await assert.rejects(()=>runTaggedEdits(f.prepared,f.output,{maxCalls:3,provider}),/Frozen prompt/);
      assert.equal(calls,0);assert.equal(existsSync(f.output),false);
    }finally{f.cleanup();}
  });
  it('exercises the default provider recorder through mocked fetch, preserves exact code, and detects tampering',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},async t=>{
    const f=fixture(),old=process.env['EVAL_API_KEY'];const requests:Record<string,unknown>[]=[];
    process.env['EVAL_API_KEY']='fixture-runtime-key-never-written';
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({model:'deepseek-flash',choices:[{message:{content:'```java\n'+source+'\n```'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
    });
    try{
      const original=readFileSync(join(f.prepared,'manifest.json'),'utf8');
      const report=await runTaggedEdits(f.prepared,f.output,{maxCalls:3});
      assert.equal(requests.length,3);assert.ok(requests.every(r=>!('seed'in r)&&r['temperature']===0&&r['max_tokens']===8192));
      assert.equal(report.controlled_model_comparison,true);assert.equal(report.request_attempts,3);
      assert.match(readFileSync(join(f.output,'report.md'),'utf8'),/完整任务完成率未核定/);
      assert.ok(report.records.every(r=>r.compile==='ok'&&r.behavior==='ok'&&r.task==='review_required'));
      assert.ok(report.summary.every(s=>s.usage_coverage===1&&s.usage_known_subtotal?.total_tokens===30&&s.task_completion_rate===null));
      assert.equal(readFileSync(join(f.prepared,'manifest.json'),'utf8'),original);
      assert.equal(readFileSync(join(f.output,'manifest.json'),'utf8'),original);
      const generated=join(f.output,'results/baseline/EDIT-QUEUE-1.java');assert.equal(readFileSync(generated,'utf8'),source);
      writeFileSync(generated,source+'\n// edited');
      assert.throws(()=>evaluateEdits(f.output,join(f.root,'tampered.json')),/generated source changed/);
      writeFileSync(generated,source);
      const raw=join(f.output,'raw/baseline/EDIT-QUEUE-1.json');writeFileSync(raw,readFileSync(raw,'utf8')+' ');
      assert.throws(()=>evaluateEdits(f.output,join(f.root,'raw-tampered.json')),/Raw provider response changed/);
      await assert.rejects(()=>runTaggedEdits(f.prepared,f.output,{maxCalls:3}),/fresh/);
    }finally{t.mock.restoreAll();if(old===undefined)delete process.env['EVAL_API_KEY'];else process.env['EVAL_API_KEY']=old;f.cleanup();}
  });
  it('stops after access failure, retains incomplete coverage and omits provider error secrets',async()=>{
    const f=fixture();let calls=0;
    try{
      const report=await runTaggedEdits(f.prepared,f.output,{maxCalls:3,provider:async()=>{calls++;throw new Error('HTTP 402 private-key-that-must-not-be-recorded');}});
      assert.equal(calls,1);assert.equal(report.request_attempts,1);assert.equal(report.model_requests,0);
      assert.equal(report.controlled_model_comparison,false);assert.equal(report.present,0);
      assert.ok(report.summary.every(s=>s.usage_known_subtotal===null&&s.behavior.evaluated===0));
      const record=readFileSync(join(f.output,'calls/baseline/EDIT-QUEUE-1.json'),'utf8');
      assert.match(record,/HTTP 402/);assert.ok(!record.includes('private-key-that-must-not-be-recorded'));
    }finally{f.cleanup();}
  });
  it('retains truncated raw output and usage without retrying or repairing it',async()=>{
    const f=fixture();let calls=0;
    try{
      const report=await runTaggedEdits(f.prepared,f.output,{maxCalls:3,provider:async()=>({...reply(),finish_reason:++calls===1?'length':'stop'})});
      assert.equal(calls,3);assert.equal(report.records[0]!.output,'invalid');
      assert.equal(report.records[0]!.task,'failed');assert.equal(report.records[0]!.compile,'not_run');
      assert.ok(existsSync(join(f.output,'raw/baseline/EDIT-QUEUE-1.json')));
      assert.equal(existsSync(join(f.output,'results/baseline/EDIT-QUEUE-1.java')),false);
      assert.equal(report.summary[0]!.usage_known_subtotal?.total_tokens,30);
      assert.equal(report.controlled_model_comparison,false); // Injected adapters never claim real provider provenance.
    }finally{f.cleanup();}
  });
  it('stops on model alias changes and keeps reported usage',async()=>{
    const f=fixture();let calls=0;
    try{
      const report=await runTaggedEdits(f.prepared,f.output,{maxCalls:3,provider:async()=>{calls++;return {...reply(),model:'other-model'};}});
      assert.equal(calls,1);assert.equal(report.present,0);assert.equal(report.summary[0]!.usage_known_subtotal?.total_tokens,30);
      assert.equal(JSON.parse(readFileSync(join(f.output,'execution.json'),'utf8')).status,'provider_failed');
    }finally{f.cleanup();}
  });
  it('halts before the next request when frozen inputs change during a call',async()=>{
    const f=fixture();let calls=0;
    try{
      await assert.rejects(()=>runTaggedEdits(f.prepared,f.output,{maxCalls:3,provider:async()=>{
        calls++;const file=join(f.output,'prompts/rag/EDIT-QUEUE-1.md');writeFileSync(file,readFileSync(file,'utf8')+'changed');return reply();
      }}),/invalidated/);
      assert.equal(calls,1);assert.ok(existsSync(join(f.output,'calls/baseline/EDIT-QUEUE-1.json')));
      assert.equal(JSON.parse(readFileSync(join(f.output,'execution.json'),'utf8')).status,'invalidated');
    }finally{f.cleanup();}
  });
  it('keeps imported reference outputs separate from recorded model experiments',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},()=>{
    const f=fixture();
    try{
      mkdirSync(join(f.prepared,'results/baseline'),{recursive:true});writeFileSync(join(f.prepared,'results/baseline/EDIT-QUEUE-1.java'),source);
      const report=evaluateEdits(f.prepared,join(f.root,'imported.json'));
      assert.equal(report.controlled_model_comparison,false);assert.equal(report.model_requests,0);
      assert.equal(report.records[0]!.behavior,'ok');assert.equal(report.records[0]!.usage,null);
    }finally{f.cleanup();}
  });
});
