import { strict as assert } from 'node:assert';
import { describe,it } from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256,TASK_CRITERIA } from '../eval/acceptance.ts';
import { checkPublicApi } from '../eval/api-compatibility.ts';
import { runExperiment } from '../eval/experiment.ts';
import { runRepairExperiment } from '../eval/repair-experiment.ts';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';

describe('public API and real repair experiment adapters',()=>{
  it('protects package, constructors, overloads and method types/static modifiers',()=>{
    const before='package p; public class A { public A(){} public A(int n){} public static java.util.List<String> items(int n){return null;} }';
    assert.equal(checkPublicApi(before,before.replace('java.util.List','List')).status,'ok');
    assert.equal(checkPublicApi(before,before.replace('public A(){}','')).status,'failed');
    assert.equal(checkPublicApi(before,before.replace('static ','')).status,'failed');
    assert.equal(checkPublicApi(before,before.replace('package p','package q')).status,'failed');
    assert.equal(checkPublicApi(before,before.replace('List<String>','List<Integer>')).status,'failed');
    assert.equal(checkPublicApi('public class A {}','public class A { public A(int n){} }').status,'failed');
    assert.equal(checkPublicApi(before,'class Broken { void f( }').status,'unavailable');
  });
  const javac=process.env['EVAL_JAVAC']??'javac';const java=process.env['EVAL_JAVA']??'java';
  it('retains first-pass failure and enforces a separate paid-call budget through the real engine repair API',
    {skip:spawnSync(javac,['-version']).status!==0&&'JDK unavailable'},async()=>{
    const dir=mkdtempSync(join(tmpdir(),'repair-experiment-test-'));
    try{
      const good=readFileSync(join(REPOSITORY_ROOT,'cases/CASE-019-negative-control/before.java'),'utf8');
      const bad=good.replace('BigDecimal.ZERO','UNDEFINED_TOTAL === null');assert.notEqual(bad,good);
      const provider=join(dir,'provider.cjs');writeFileSync(provider,
        'const fs=require("node:fs");const request=JSON.parse(fs.readFileSync(0,"utf8"));'+
        `const code=request.prompt.includes("本轮验证反馈")?${JSON.stringify(good)}:${JSON.stringify(bad)};`+
        'process.stdout.write(JSON.stringify({model:request.model,code,finish_reason:"stop",usage:{total_tokens:1}}));');
      const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({model:'mock',command:process.execPath,args:[provider],seed:42,temperature:0,
        maxOutputTokens:1000,maxCalls:1,timeoutMs:1000,tokenBudget:1200,topK:5,caseIds:['CASE-019'],strategies:['rules'],java:{javac,java,
          ...(process.env['EVAL_CLASSPATH']?{classpath:process.env['EVAL_CLASSPATH'].split(delimiter)}:{})}}));
      const first=join(dir,'first');assert.throws(()=>runExperiment(config,first),/Experiment incomplete/);
      const originalReport=readFileSync(join(first,'report.json'),'utf8');const originalCode=readFileSync(join(first,'results/rules/CASE-019.java'),'utf8');
      assert.equal(JSON.parse(originalReport).agent[0].compile,'failed');
      const zero=join(dir,'zero');await runRepairExperiment(first,zero,0);
      const untouched=JSON.parse(readFileSync(join(zero,'summary.json'),'utf8'));assert.equal(untouched.actual_calls,0);assert.equal(untouched.remaining_cases.length,1);
      const out=join(dir,'repair');await runRepairExperiment(first,out,1);
      const result=JSON.parse(readFileSync(join(out,'summary.json'),'utf8'));assert.equal(result.actual_calls,1);assert.equal(result.outcomes[0].status,'passed');
      assert.equal(readFileSync(join(first,'report.json'),'utf8'),originalReport);assert.equal(readFileSync(join(first,'results/rules/CASE-019.java'),'utf8'),originalCode);
      assert.equal(JSON.parse(readFileSync(join(out,'CASE-019/call-1.json'),'utf8')).status,'ok');
      assert.equal(JSON.parse(readFileSync(join(out,'CASE-019/candidate-1.checks.json'),'utf8')).tests.status,'ok');
      await assert.rejects(()=>runRepairExperiment(first,out,1),/fresh repair directory/);
      const resumed=join(dir,'continued');await runRepairExperiment(first,resumed,1,{continueFrom:out});
      assert.equal(JSON.parse(readFileSync(join(resumed,'summary.json'),'utf8')).actual_calls,0);
      assert.equal(readFileSync(join(resumed,'CASE-019/candidate-0.java'),'utf8'),good);
      const reviews=join(dir,'reviews');mkdirSync(reviews);
      writeFileSync(join(reviews,'CASE-019.json'),JSON.stringify({source_sha256:sha256(good),reviewer:'fixture reviewer',criteria:TASK_CRITERIA['CASE-019']!.map((criterion,index)=>({criterion,passed:index!==0,evidence:'SOURCE_BOUND_REVIEW_DIAGNOSTIC'}))}));
      const reviewed=join(dir,'reviewed');await runRepairExperiment(first,reviewed,1,{continueFrom:out,reviewsDir:reviews});
      assert.equal(JSON.parse(readFileSync(join(reviewed,'summary.json'),'utf8')).outcomes[0].status,'stalled');
      assert.equal(JSON.parse(readFileSync(join(reviewed,'CASE-019/candidate-0.checks.json'),'utf8')).task_check.status,'failed');
      assert.match(readFileSync(join(reviewed,'CASE-019/call-1.prompt.md'),'utf8'),/SOURCE_BOUND_REVIEW_DIAGNOSTIC/);
      assert.equal(JSON.parse(readFileSync(join(reviewed,'experiment.json'),'utf8')).task_reviews.sha256['CASE-019'],sha256(readFileSync(join(reviews,'CASE-019.json'),'utf8')));
      const chain=JSON.parse(readFileSync(join(resumed,'experiment.json'),'utf8')).continuation;
      assert.equal(chain.directory,out);assert.equal(chain.candidates['CASE-019'].source_sha256,JSON.parse(readFileSync(join(out,'CASE-019/call-1.json'),'utf8')).source_sha256);
      writeFileSync(join(out,'CASE-019/candidate-1.java'),good+'\n// changed after verification');
      await assert.rejects(()=>runRepairExperiment(first,join(dir,'tampered'),1,{continueFrom:out}),/source changed since verification/);
      const priorManifest=JSON.parse(readFileSync(join(out,'experiment.json'),'utf8'));priorManifest.source_manifest_sha256='wrong';
      writeFileSync(join(out,'experiment.json'),JSON.stringify(priorManifest));
      await assert.rejects(()=>runRepairExperiment(first,join(dir,'unrelated'),1,{continueFrom:out}),/different first-pass experiment/);

    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
