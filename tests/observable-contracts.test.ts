import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { OBSERVABLE_CASES } from '../eval/business-contracts.ts';
import { deliveryContract } from '../eval/delivery-contract.ts';
import { acceptanceTest } from '../eval/acceptance.ts';
import { runExperiment, validateExperimentConfig, type ExperimentConfig } from '../eval/experiment.ts';
import { runEvaluation } from '../eval/runner.ts';
import { checkJava } from '../eval/java.ts';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';
const javac=process.env['EVAL_JAVAC']??'javac',java=process.env['EVAL_JAVA']??'java';
const classpath=process.env['EVAL_CLASSPATH']?.split(delimiter);
const available=spawnSync(javac,['-version']).status===0&&classpath!==undefined;

it('makes observable contracts opt-in without changing v1 or unrelated tasks',()=>{
  assert.equal(OBSERVABLE_CASES.length,7);
  assert.doesNotMatch(deliveryContract({id:'CASE-001'}),/Consumer<com/);
  assert.match(deliveryContract({id:'CASE-001'},2),/Consumer<com/);
  assert.equal(deliveryContract({id:'CASE-019'},1),deliveryContract({id:'CASE-019'},2));
  assert.equal(acceptanceTest('CASE-001')?.testClass,'RuntimeAcceptance');
  assert.equal(acceptanceTest('CASE-001',2)?.testClass,'BusinessAcceptance');
  const dir=mkdtempSync(join(tmpdir(),'observable-prepare-'));
  try{
    const config:ExperimentConfig={model:'prepare-only',command:'unused',args:[],seed:42,temperature:0,maxOutputTokens:1000,maxCalls:21,timeoutMs:10000,tokenBudget:1200,topK:5,businessContractVersion:2,caseIds:[...OBSERVABLE_CASES]};
    assert.throws(()=>validateExperimentConfig({...config,businessContractVersion:3 as 2}),/businessContractVersion/);
    const path=join(dir,'config.json');writeFileSync(path,JSON.stringify(config));
    runExperiment(path,join(dir,'prepared'),true);
    const manifest=JSON.parse(readFileSync(join(dir,'prepared/experiment.json'),'utf8'));
    assert.equal(manifest.config.businessContractVersion,2);assert.equal(manifest.planned_calls,21);
    for(const strategy of ['baseline','rag','rules'])assert.match(readFileSync(join(dir,'prepared/prompts',strategy,'CASE-001.md'),'utf8'),/Consumer<com/);
    const options={casesDir:join(REPOSITORY_ROOT,'cases'),outputDir:join(dir,'prepared'),caseIds:[...OBSERVABLE_CASES],evaluateAgentResults:true};
    const inferred=runEvaluation(options);
    assert.ok(!inferred.provenance.issues.some(issue=>issue.includes('settings differ')));
    const mismatch=runEvaluation({...options,businessContractVersion:1});
    assert.ok(mismatch.provenance.issues.some(issue=>issue.includes('settings differ')));
    assert.equal(mismatch.provenance.controlled_experiment,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

it('verifies all seven callback references and rejects counter-only or caller-thread substitutes',
 {skip:!available&&'JDK/dependency classpath unavailable'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'observable-business-'));
  try{
    const source=join(dir,'input.java');
    for(const id of OBSERVABLE_CASES){
      writeFileSync(source,readFileSync(join(REPOSITORY_ROOT,'eval/contracts/v2',`${id}.java`),'utf8'));
      const result=checkJava(source,{javac,java,classpath,...acceptanceTest(id,2)});
      assert.equal(result.compile.status,'ok',`${id}: ${result.compile.detail}`);
      assert.equal(result.tests.status,'ok',`${id}: ${result.tests.detail}`);
    }
    const exportCode=readFileSync(join(REPOSITORY_ROOT,'eval/contracts/v2/CASE-003.java'),'utf8');
    const contextCode=readFileSync(join(REPOSITORY_ROOT,'eval/contracts/v2/CASE-002.java'),'utf8');
    const examples=[
      {id:'CASE-003',code:exportCode.replace('downstream.accept(input);','/* no actual effect */'),message:/Real callback never started/},
      {id:'CASE-003',code:exportCode.replace('exporter.execute(() -> invoke(input));','invoke(input);'),message:/Initial submission failed/},
      {id:'CASE-003',code:exportCode.replace('rejected.incrementAndGet();','rejected.addAndGet(0);'),message:/Rejection counted zero or multiple times/},
      {id:'CASE-002',code:contextCode.replace('if(previous == null) TENANT.remove(); else TENANT.set(previous);','/* worker context not restored */'),message:/Worker tenant context leaked/},
    ];
    for(const example of examples){
      writeFileSync(source,example.code);const result=checkJava(source,{javac,java,classpath,...acceptanceTest(example.id,2)});
      assert.equal(result.compile.status,'ok',result.compile.detail);assert.equal(result.tests.status,'failed');assert.match(result.tests.detail,example.message);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
