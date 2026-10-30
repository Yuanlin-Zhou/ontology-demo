/** Separate paid follow-up: retains first-pass results and never retries a recorded provider call. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RepairResult } from '../src/api/repair.ts';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { acceptanceTest, acceptanceScenarios, readTaskReview, sha256 } from './acceptance.ts';
import { checkJava } from './java.ts';
import { checkPublicApi } from './api-compatibility.ts';
import { loadCases, readCaseFile, writeJson } from './cases.ts';
import { extractJavaSource } from './model-output.ts';
import { deliveryContract } from './delivery-contract.ts';
import { validateExperimentConfig, type ExperimentConfig } from './experiment.ts';
import type { EvalReport } from './runner.ts';

export async function runRepairExperiment(sourceRun: string, outputDir: string, maxCalls = 12, options: { revisedEngine?: boolean; caseIds?: string[]; continueFrom?: string; reviewsDir?: string } = {}): Promise<void> {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 42) throw new Error('Repair maxCalls must be between 0 and 42.');
  if (existsSync(outputDir)) throw new Error('Use a fresh repair directory; attempts must never be overwritten or silently retried.');
  const originalManifest = readFileSync(join(sourceRun,'experiment.json'),'utf8');
  const manifest = JSON.parse(originalManifest) as { config: ExperimentConfig; working_tree_patch_sha256: string; untracked_sha256: Record<string,string> };
  const config = manifest.config; validateExperimentConfig(config);
  const report = JSON.parse(readFileSync(join(sourceRun,'report.json'),'utf8')) as EvalReport;
  if (!report.provenance.controlled_experiment || report.agent.some(a => !existsSync(a.file))) throw new Error('Require a complete first-pass experiment with retained source and matching provenance.');
  const diff = spawnSync('git',['diff','--binary','HEAD'],{cwd:REPOSITORY_ROOT,encoding:'utf8'}).stdout ?? '';
  const untracked=spawnSync('git',['ls-files','--others','--exclude-standard'],{cwd:REPOSITORY_ROOT,encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean);
  const hashes=Object.fromEntries(untracked.map(file=>[file,sha256(readFileSync(join(REPOSITORY_ROOT,file),'utf8'))]));
  if (!options.revisedEngine && JSON.stringify(hashes)!==JSON.stringify(manifest.untracked_sha256)) throw new Error('Untracked code changed since first pass.');
  if (!options.revisedEngine && sha256(diff) !== manifest.working_tree_patch_sha256) throw new Error('Code changed since first pass; freeze a new experiment before repair.');
  const cases = loadCases(join(REPOSITORY_ROOT,'cases'), config.caseIds);
  const engine = RuleEngine.load();
  const audit = report.agent.map(a => {
    const testCase = cases.find(c => c.id === a.case_id)!;
    const source = readFileSync(a.file,'utf8');
    if (sha256(source) !== a.source_sha256) throw new Error('First-pass source changed.');
    return { case_id:a.case_id, strategy:a.strategy, source_sha256:a.source_sha256, api_check:checkPublicApi(readCaseFile(testCase,'before') ?? '',source) };
  });
  if (options.caseIds && (!options.caseIds.length || options.caseIds.some(id => !cases.some(c => c.id === id)))) throw new Error('Unknown or empty repair case selection.');
  const targets = report.agent.filter(a => (!options.caseIds || options.caseIds.includes(a.case_id)) && a.strategy === 'rules' && (a.errors > 0 || a.compile !== 'ok' || a.test_check.status !== 'ok' || a.task_check.status === 'failed' ||
    (options.revisedEngine && options.caseIds?.includes(a.case_id)) ||
    audit.find(x => x.case_id === a.case_id && x.strategy === a.strategy)?.api_check.status === 'failed'))
    .sort((a,b) => Number(b.compile !== 'ok')-Number(a.compile !== 'ok') || Number(b.test_check.status !== 'ok')-Number(a.test_check.status !== 'ok') || a.case_id.localeCompare(b.case_id));
  // Continue from a recorded model result, never from an untracked hand-edited source.
  const continued = new Map<string,{code:string;source_sha256:string;result_sha256:string}>();
  let continuationManifestHash: string | undefined;
  if (options.continueFrom) {
    const previousManifest=readFileSync(join(options.continueFrom,'experiment.json'),'utf8');
    const previous=JSON.parse(previousManifest) as {source_manifest_sha256?:string};
    if(previous.source_manifest_sha256!==sha256(originalManifest))throw new Error('Continuation belongs to a different first-pass experiment.');
    continuationManifestHash=sha256(previousManifest);
    for(const target of targets){
      const dir=join(options.continueFrom,target.case_id);
      const raw=readFileSync(join(dir,'result.json'),'utf8');
      const result=JSON.parse(raw) as RepairResult;
      const last=result.attempts.at(-1);
      if(!last || last.code!==result.code)throw new Error('Continuation has no matching final verification.');
      const file=join(dir,`candidate-${result.attempts.length-1}.java`);
      const checks=JSON.parse(readFileSync(file.replace(/\.java$/,'.checks.json'),'utf8')) as {source_sha256:string};
      if(readFileSync(file,'utf8')!==result.code || checks.source_sha256!==sha256(result.code))throw new Error('Continuation source changed since verification.');
      continued.set(target.case_id,{code:result.code,source_sha256:checks.source_sha256,result_sha256:sha256(raw)});
    }
  }
  const reviewDir=resolve(options.reviewsDir??join(sourceRun,'reviews','rules'));
  const reviewHashes=Object.fromEntries(targets.filter(t=>existsSync(join(reviewDir,`${t.case_id}.json`))).map(t=>[t.case_id,sha256(readFileSync(join(reviewDir,`${t.case_id}.json`),'utf8'))]));
  mkdirSync(outputDir,{recursive:true});
  writeJson(join(outputDir,'experiment.json'),{protocol:5,kind:options.revisedEngine?'revised-engine-targeted-followup':'rules-repair-followup',working_tree_patch_sha256:sha256(diff),untracked_sha256:hashes,source_run:sourceRun,source_manifest_sha256:sha256(originalManifest),
    continuation:options.continueFrom?{directory:resolve(options.continueFrom),manifest_sha256:continuationManifestHash,candidates:Object.fromEntries([...continued].map(([id,item])=>[id,{source_sha256:item.source_sha256,result_sha256:item.result_sha256}]))}:undefined,
    task_reviews:{directory:reviewDir,sha256:reviewHashes},
    config,max_calls:maxCalls,max_repairs_per_case:2,target_case_ids:targets.map(t=>t.case_id),created_at:new Date().toISOString()});
  writeFileSync(join(outputDir,'working-tree.patch'),diff);
  writeJson(join(outputDir,'first-pass-api-audit.json'),audit);
  let calls = 0; const outcomes: unknown[] = [];
  let stopped: string | undefined;
  try {
    for (const target of targets) {
      if (calls >= maxCalls) break;
      const testCase = cases.find(c=>c.id===target.case_id)!;
      const original = readCaseFile(testCase,'before') ?? '';
      const dir=join(outputDir,target.case_id);mkdirSync(dir,{recursive:true});
      let verificationIndex=0;
      const result=await engine.repair({task:testCase.task,code:continued.get(target.case_id)?.code??readFileSync(target.file,'utf8'),maxRepairs:Math.min(2,maxCalls-calls),tokenBudget:config.tokenBudget,
        verify:code=>{
          const file=join(dir,`candidate-${verificationIndex++}.java`);writeFileSync(file,code);
          const javaOptions={...config.java,...acceptanceTest(testCase.id, config.businessContractVersion ?? 1)};
          const checks=checkJava(file,javaOptions);const api=checkPublicApi(original,code);
          // Report independent behavior failures even when the complete path fails earlier.
          const scenarios=acceptanceScenarios(testCase.id);
          const scenarioChecks=scenarios.length && checks.compile.status==='ok'
            ? Object.fromEntries(scenarios.map(name=>[name.replaceAll('-','_'),checkJava(file,{...javaOptions,testArgs:[name]})])) : undefined;
          const scenarioFailure=scenarioChecks && Object.values(scenarioChecks).find(c=>c.compile.status!=='ok'||c.tests.status!=='ok');
          const testStatus=checks.tests.status==='ok' && scenarioFailure ? scenarioFailure.tests.status : checks.tests.status;
          // Re-read against each candidate hash. A review of the initial source cannot bless an edit.
          const review=readTaskReview(join(reviewDir,`${testCase.id}.json`),code,testCase.id);
          const task = review.status === 'failed' ? review : ['CASE-004','CASE-006','CASE-017','CASE-019'].includes(testCase.id)
            ? {status:checks.tests.status,detail:'Complete scoped task criteria exercised by deterministic acceptance.'}
            : review;
          writeJson(file.replace(/\.java$/,'.checks.json'),{source_sha256:sha256(code),acceptance_sha256:javaOptions.testSource?sha256(readFileSync(javaOptions.testSource,'utf8')):undefined,...checks,scenario_checks:scenarioChecks,api_check:api,task_check:task});
          return {compile:checks.compile.status,tests:testStatus==='ok'?api.status:testStatus,task:task.status,
            diagnostics:[checks.compile.detail,checks.tests.detail,...Object.entries(scenarioChecks??{}).map(([name,c])=>`${name}: ${c.compile.status}/${c.tests.status}\n${c.compile.detail}${c.tests.detail}`),api.detail,task.detail].filter(Boolean).join('\n')};
        },
        generate:({prompt,attempt})=>{
          calls++;
          const stem=join(dir,`call-${attempt}`);
          const fullPrompt=prompt+`\n\n## 原始输入（公开接口与业务基准）\n\`\`\`java\n${original}\n\`\`\``+deliveryContract(testCase, config.businessContractVersion ?? 1);
          writeFileSync(stem+'.prompt.md',fullPrompt);
          writeJson(stem+'.json',{status:'started',global_call:calls,prompt_sha256:sha256(fullPrompt)});
          const response=spawnSync(config.command,config.args,{cwd:REPOSITORY_ROOT,encoding:'utf8',timeout:config.timeoutMs,killSignal:'SIGKILL',maxBuffer:2*1024*1024,
            input:JSON.stringify({model:config.model,seed:config.seed,temperature:config.temperature,maxOutputTokens:config.maxOutputTokens,apiBase:config.apiBase,apiKeyEnv:config.apiKeyEnv,sendSeed:config.sendSeed,prompt:fullPrompt})});
          if (response.status !== 0 || response.error) {
            const status=response.stderr?.match(/HTTP (\d{3})/)?.[1];
            writeJson(stem+'.json',{status:'failed',global_call:calls,prompt_sha256:sha256(fullPrompt),failure:status?`HTTP ${status}`:'Provider failed or timed out; no automatic retry.'});
            throw new Error('Repair provider failed; stopping further calls.');
          }
          writeFileSync(stem+'.raw.json',response.stdout);
          const output=JSON.parse(response.stdout) as {model:string;code:string;finish_reason?:string;usage?:unknown;applied_parameters?:unknown};
          writeJson(stem+'.json',{status:'received',global_call:calls,prompt_sha256:sha256(fullPrompt),usage:output.usage,applied_parameters:output.applied_parameters});
          if (output.model !== config.model || (output.finish_reason !== undefined && output.finish_reason !== 'stop')) throw new Error('Repair response model/finish reason mismatch.');
          const extracted=extractJavaSource(output.code);
          writeFileSync(stem+'.java',extracted.code);
          writeJson(stem+'.json',{status:'ok',global_call:calls,prompt_sha256:sha256(fullPrompt),usage:output.usage,applied_parameters:output.applied_parameters,
            source_sha256:extracted.source_sha256,raw_sha256:extracted.raw_sha256,format:extracted.format});
          return extracted.code;
        }});
      writeJson(join(dir,'result.json'),result);outcomes.push({case_id:target.case_id,status:result.status,model_calls:result.model_calls,
        initial_errors:result.attempts[0]?.validation.violations.filter(v=>v.severity==='error').length,
        final_errors:result.attempts.at(-1)?.validation.violations.filter(v=>v.severity==='error').length});
      console.log(`${target.case_id}: ${result.status}, ${result.model_calls} extra call(s)`);
    }
  } catch(error) { stopped=String(error);throw error; }
  finally {writeJson(join(outputDir,'summary.json'),{kind:'repair-followup',max_calls:maxCalls,actual_calls:calls,target_count:targets.length,outcomes,stopped,
    remaining_cases:targets.filter(t=>!outcomes.some(o=>(o as {case_id:string}).case_id===t.case_id)).map(t=>t.case_id)});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [source,out,budget,revision,cases,continuationFlag,continuationDir]=process.argv.slice(2);if(!source||!out||(revision!==undefined&&revision!=='--revised-engine')||(continuationFlag!==undefined&&(continuationFlag!=='--continue-from'||!continuationDir)))throw new Error('Usage: node eval/repair-experiment.ts FIRST_RUN OUT_DIR [MAX_CALLS] [--revised-engine CASE-020 [--continue-from PREVIOUS_REPAIR]]');
  await runRepairExperiment(resolve(source),resolve(out),budget===undefined?12:Number(budget),revision?{revisedEngine:true,caseIds:(cases??'').split(',').filter(Boolean),...(continuationDir?{continueFrom:resolve(continuationDir)}:{})}:{});
}
