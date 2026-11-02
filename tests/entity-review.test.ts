import { strict as assert } from 'node:assert';
import { describe,it } from 'node:test';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { prepareReview,sealReview,scoreReview,type ReviewLabels } from '../eval/entity-review/workflow.ts';
import { checkJava } from '../eval/java.ts';
import { auditEditCategories } from '../eval/entity-review/edit-audit.ts';

function fixture(budget=1200){
  const root=mkdtempSync(join(tmpdir(),'entity-review-'));const config=join(root,'suite.json');
  const suite=JSON.parse(readFileSync('eval/entity-review/suite.json','utf8'));suite.tokenBudget=budget;
  writeFileSync(config,JSON.stringify(suite));const output=join(root,'package');prepareReview(config,output);
  return {root,config,output,packet:join(output,'reviewer'),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
// Synthetic declarations exist only in temporary unit-test data. They are not a human review.
function labels(f:ReturnType<typeof fixture>):ReviewLabels {
  const value:ReviewLabels=JSON.parse(readFileSync(join(f.packet,'annotations.template.json'),'utf8'));
  const tasks=JSON.parse(readFileSync(join(f.packet,'tasks.json'),'utf8'));
  const required:Record<string,string>={'REVIEW-CAPACITY':'tp.create.queue','REVIEW-TENANT':'tp.use.context','REVIEW-FAILURE':'tp.use.exception'};
  value.reviewer={identity:'unit-test-only-not-a-real-reviewer',kind:'domain_reviewer',independent_of_engine_development:true,not_task_author:true,no_predictions_seen:true,leaf_definitions_reviewed:true};
  for(const c of value.cases)for(const l of c.leaves){l.decision=l.leaf===required[c.id]?'required':'irrelevant';l.evidence='Synthetic unit-test annotation, never production gold';l.evidence_entities=l.decision==='required'?[tasks.find((t:{id:string})=>t.id===c.id).target]:[];}
  return value;
}
function saveLabels(f:ReturnType<typeof fixture>,value:ReviewLabels){const file=join(f.root,'filled.json');writeFileSync(file,JSON.stringify(value));return file;}

describe('external task-relevance review workflow',()=>{
  it('separates a prediction-free reviewer packet from engine correspondence and leaves all gold blank',()=>{
    const f=fixture();try{
      const template:ReviewLabels=JSON.parse(readFileSync(join(f.packet,'annotations.template.json'),'utf8'));
      assert.ok(template.cases.every(c=>c.leaves.length===15&&c.leaves.every(l=>l.decision===null&&l.evidence==='')));
      assert.equal(JSON.parse(readFileSync(join(f.output,'review-state.json'),'utf8')).metrics,null);
      const catalog=readFileSync(join(f.packet,'leaf-catalog.json'),'utf8');assert.ok(!catalog.includes('any_features'));
      const allPublic=readdirSync(f.packet).filter(p=>p.endsWith('.json')).map(p=>readFileSync(join(f.packet,p),'utf8')).join('');
      assert.ok(!allPublic.includes('selected_leaf_ids'));assert.ok(!allPublic.includes('provenance'));
      const privateData=JSON.parse(readFileSync(join(f.output,'engine/predictions.json'),'utf8'));
      assert.ok(privateData.cases.every((c:{retrieval:{provenance:Record<string,Array<{via:string}>>}})=>Object.values(c.retrieval.provenance).flat().every(x=>x.via!=='planned')));
      assert.throws(()=>sealReview(f.packet,join(f.packet,'annotations.template.json'),join(f.root,'seal.json')),/External domain review/);
    }finally{f.cleanup();}
  });
  it('rejects planned knowledge and ambiguous interface/implementation selectors',()=>{
    const f=fixture();try{
      const suite=JSON.parse(readFileSync(f.config,'utf8'));suite.cases[0].planned=[{leaf:'tp.create.queue',reason:'not allowed in primary cohort'}];writeFileSync(f.config,JSON.stringify(suite));
      assert.throws(()=>prepareReview(f.config,join(f.root,'new-planned')),/forbids planned/);
      suite.cases[0].planned=[];suite.cases[1].target='process(String,String)';writeFileSync(f.config,JSON.stringify(suite));
      assert.throws(()=>prepareReview(f.config,join(f.root,'ambiguous')),/Ambiguous/);
    }finally{f.cleanup();}
  });
  it('requires complete source-bound labels, entity evidence and independent-review declarations',()=>{
    const f=fixture();try{
      for(const mutate of [
        (r:ReviewLabels)=>{r.reviewer.kind='agent';},
        (r:ReviewLabels)=>{r.reviewer.no_predictions_seen=false;},
        (r:ReviewLabels)=>{r.package_hash='another-package';},
        (r:ReviewLabels)=>{r.cases[0]!.source_hash='changed-source';},
        (r:ReviewLabels)=>{r.cases[0]!.leaves.pop();},
        (r:ReviewLabels)=>{r.cases[0]!.leaves[0]!.decision=null;},
        (r:ReviewLabels)=>{r.cases[0]!.leaves.find(l=>l.decision==='required')!.evidence_entities=['missing-entity'];},
      ]){const value=labels(f);mutate(value);assert.throws(()=>sealReview(f.packet,saveLabels(f,value),join(f.root,'rejected-seal.json')));}
    }finally{f.cleanup();}
  });
  it('separates tagging misses from budget omissions without turning empty retrieval into perfect precision',()=>{
    const f=fixture(0);try{
      const seal=join(f.root,'sealed.json');sealReview(f.packet,saveLabels(f,labels(f)),seal);
      const result=scoreReview(f.packet,seal,join(f.root,'metrics.json'));
      assert.equal(result.independent_holdout_verified,false);assert.equal(result.full_entity_tag_accuracy,null);
      assert.equal(result.independence,'reviewer_declared_not_authenticated');
      for(const c of result.results){assert.equal(c.unbudgeted.required_recall,1);assert.equal(c.budgeted.required_recall,0);assert.equal(c.budgeted.precision_decided,null);assert.equal(c.dropped_required.length,1);}
      assert.throws(()=>scoreReview(f.packet,seal,join(f.root,'metrics.json')),/fresh/);
    }finally{f.cleanup();}
  });
  it('excludes uncertain labels and does not invent recall when reviewers mark no required knowledge',()=>{
    const f=fixture();try{
      const value=labels(f);for(const c of value.cases)for(const l of c.leaves){l.decision='uncertain';l.evidence_entities=[];}
      const sealed=join(f.root,'sealed.json');sealReview(f.packet,saveLabels(f,value),sealed);
      const result=scoreReview(f.packet,sealed,join(f.root,'metrics.json'));
      assert.ok(result.results.every(c=>c.budgeted.precision_decided===null&&c.budgeted.required_recall===null&&c.budgeted.uncertain_selected>0));
    }finally{f.cleanup();}
  });
  it('refuses source, budget and sealed-label changes',()=>{
    const f=fixture();try{
      const seal=join(f.root,'sealed.json');sealReview(f.packet,saveLabels(f,labels(f)),seal);
      const data=JSON.parse(readFileSync(seal,'utf8'));data.labels.cases[0].leaves[0].evidence='edited';writeFileSync(seal,JSON.stringify(data));
      assert.throws(()=>scoreReview(f.packet,seal,join(f.root,'no-metrics.json')),/Sealed review/);
      const manifestPath=join(f.packet,'packet-manifest.json'),old=readFileSync(manifestPath,'utf8');const manifest=JSON.parse(old);manifest.tokenBudget=1;writeFileSync(manifestPath,JSON.stringify(manifest));
      assert.throws(()=>sealReview(f.packet,saveLabels(f,labels(f)),join(f.root,'changed-budget.json')),/package\/knowledge changed/);
      writeFileSync(manifestPath,old);const source=join(f.packet,'inputs/REVIEW-CAPACITY/ExportWorker.java');writeFileSync(source,readFileSync(source,'utf8')+'\n// changed');
      assert.throws(()=>sealReview(f.packet,saveLabels(f,labels(f)),join(f.root,'changed-source.json')),/Frozen review source/);
    }finally{f.cleanup();}
  });
});

describe('candidate edit behavior contracts',()=>{
  it('keeps raw policy findings while describing changed categories, rather than calling them new defects',()=>{
    for(const [name,rule,policy]of [['ExportWorker','TP-CONFIG-004','propagate'],['TenantBatchService','TP-SUBMIT-004','preserve']]as const){
      const report=auditEditCategories(readFileSync(`eval/entity-review/cases/${name}.java`,'utf8'),readFileSync(`eval/entity-review/references/${name}.java`,'utf8'),policy);
      assert.ok(report.disappeared_rule_categories.includes(rule));assert.ok(report.shared_rule_categories.includes('TP-REJECT-003'));
      assert.ok(report.policy_flags.length>0);assert.equal(report.introduced_defect_count,null);assert.equal(report.full_task_completion_rate,null);
    }
  });
  it('compiles every input and accepts distinct capacity solutions while rejecting the original defects',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},()=>{
    const options={javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],release:21,testClass:'AcceptanceTest',testSource:resolve('eval/entity-review/AcceptanceTest.java')};
    for(const [name,id]of [['ExportWorker','REVIEW-CAPACITY'],['TenantBatchService','REVIEW-TENANT'],['ExceptionWorker','REVIEW-FAILURE']]){
      const good=checkJava(resolve('eval/entity-review/references',name+'.java'),{...options,testArgs:[id!]});
      assert.equal(good.compile.status,'ok',good.compile.detail);assert.equal(good.tests.status,'ok',good.tests.detail);
      const bad=checkJava(resolve('eval/entity-review/cases',name+'.java'),{...options,testArgs:[id!]});
      assert.equal(bad.compile.status,'ok',bad.compile.detail);assert.equal(bad.tests.status,'failed',bad.tests.detail);
    }
    const alternate=checkJava(resolve('eval/entity-review/references/ExportWorkerAlternative.java.txt'),{...options,testArgs:['REVIEW-CAPACITY']});
    assert.equal(alternate.compile.status,'ok',alternate.compile.detail);assert.equal(alternate.tests.status,'ok',alternate.tests.detail);
  });
  it('detects excess memory and worker-only context leakage without relying on caller leakage',
    {skip:!process.env['EVAL_JAVAC']&&'JDK selector unavailable'},()=>{
    const root=mkdtempSync(join(tmpdir(),'candidate-mutants-'));try{
      const options={javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],testClass:'AcceptanceTest',testSource:resolve('eval/entity-review/AcceptanceTest.java')};
      const queue=join(root,'ExportWorker.java');writeFileSync(queue,readFileSync('eval/entity-review/references/ExportWorker.java','utf8').replace('ArrayBlockingQueue<>(8)','ArrayBlockingQueue<>(17)'));
      const over=checkJava(queue,{...options,testArgs:['REVIEW-CAPACITY']});assert.equal(over.compile.status,'ok',over.compile.detail);assert.equal(over.tests.status,'failed');assert.match(over.tests.detail,/memory budget/);
      const context=join(root,'TenantBatchService.java');writeFileSync(context,readFileSync('eval/entity-review/references/TenantBatchService.java','utf8').replace('finally{restore(old);}});','finally{}});'));
      const leak=checkJava(context,{...options,testArgs:['REVIEW-TENANT']});assert.equal(leak.compile.status,'ok',leak.compile.detail);assert.equal(leak.tests.status,'failed');assert.match(leak.tests.detail,/Worker context leaked/);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
