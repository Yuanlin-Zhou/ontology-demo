/** Evaluate explicitly imported edit outputs; does not make model calls or claim provider provenance. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../../src/knowledge/tree.ts';
import { checkJava } from '../java.ts';
import { checkPublicApi } from '../api-compatibility.ts';
import { ruleCompliance, outcomeRate } from '../metrics.ts';
import { extractJavaSource } from '../model-output.ts';
import { readPrepared, implementationHashes, jobKey } from './artifacts.ts';
import type { EditCall, EditExecution } from './run.ts';

export function evaluateEdits(directory:string,output:string) {
  const markdown=output.endsWith('.json')?output.slice(0,-5)+'.md':output+'.md';
  if(existsSync(output)||existsSync(markdown))throw new Error('Use a fresh report path');
  const {manifest,engine}=readPrepared(directory);
  const execution:EditExecution|undefined=existsSync(join(directory,'execution.json'))?JSON.parse(readFileSync(join(directory,'execution.json'),'utf8')):undefined;
  const calls=new Map<string,EditCall>();const issues:string[]=[];
  if(execution) {
    if(execution.protocol!=='entity-tag-execution-v1'||!['provider','test_adapter'].includes(execution.mode)||
      execution.prepared_manifest_hash!==digest(readFileSync(join(directory,'manifest.json'),'utf8'))||
      execution.max_calls!==manifest.jobs.length||execution.planned_calls!==manifest.jobs.length)throw new Error('Execution manifest changed');
    if(JSON.stringify(execution.implementation)!==JSON.stringify(implementationHashes()))issues.push('Implementation changed; report is a current-engine recheck, not the frozen comparison.');
    for(const job of manifest.jobs) {
      const key=jobKey(job),path=join(directory,'calls',key+'.json');
      if(!existsSync(path))continue;
      if(digest(readFileSync(path,'utf8'))!==execution.call_hashes[key])throw new Error('Call record changed');
      const call:EditCall=JSON.parse(readFileSync(path,'utf8'));
      if(call.key!==key||call.prompt_hash!==job.prompt_hash||call.model_requested!==manifest.config.model||!['ok','started','invalid_output','failed'].includes(call.status))throw new Error('Call provenance mismatch');
      if(call.raw_hash) {
        const rawFile=join(directory,'raw',key+'.json');
        if(digest(readFileSync(rawFile,'utf8'))!==call.raw_hash)throw new Error('Raw provider response changed');
        const raw=JSON.parse(readFileSync(rawFile,'utf8'));
        if(raw.model!==call.model_returned||JSON.stringify(raw.usage)!==JSON.stringify(call.usage)||JSON.stringify(raw.applied_parameters)!==JSON.stringify(call.applied_parameters))throw new Error('Provider metadata differs from call');
        if(call.status==='ok') {
          if(raw.finish_reason!=='stop'||raw.model!==manifest.config.model||extractJavaSource(raw.code).source_sha256!==call.source_hash)throw new Error('Successful source differs from provider output');
        }
        const p=raw.applied_parameters;
        if(!p||p.endpoint!==execution.provider.endpoint||p.api_key_env!=='EVAL_API_KEY'||p.temperature!==manifest.config.temperature||p.max_tokens!==manifest.config.maxOutputTokens||p.seed!==null||p.thinking?.type!=='disabled')issues.push(`Applied provider settings not verified: ${key}`);
      }else if(call.status==='ok'||call.status==='invalid_output')throw new Error('Missing successful provider response evidence');
      calls.set(key,call);
    }
    if(execution.request_attempts!==calls.size||Object.keys(execution.call_hashes).length!==calls.size)throw new Error('Call count differs from recorded attempts');
    if(execution.mode==='test_adapter')issues.push('Injected test adapter; no real supplier model requests.');
    if(execution.status!=='complete'||calls.size!==manifest.jobs.length)issues.push('Execution incomplete; unattempted/missing outputs are not model failures.');
  }else issues.push('Imported outputs: no recorded supplier execution or measured usage.');
  const records=manifest.jobs.map(job=>{
    const call=calls.get(jobKey(job));
    const file=join(directory,'results',job.strategy,`${job.case_id}-${job.repetition}.java`);
    const usage=call?.usage??null;
    if(execution&&call?.status==='ok'&&(!existsSync(file)||digest(readFileSync(file,'utf8'))!==call.source_hash))throw new Error('Recorded generated source changed or missing');
    if(execution&&existsSync(file)&&call?.status!=='ok')throw new Error('Unrecorded source in execution directory');
    if(!existsSync(file))return {case_id:job.case_id,strategy:job.strategy,repetition:job.repetition,
      output:call?.status==='invalid_output'?'invalid':'missing',call_status:call?.status??'not_requested',
      compile:'not_run',behavior:'not_run',task:call?.status==='invalid_output'?'failed':'not_assessed',usage};
    const code=readFileSync(file,'utf8');const validation=engine.validate({code,filePath:file});
    const public_api=checkPublicApi(readFileSync(join(directory,'inputs',job.case_id+'.java'),'utf8'),code);
    const checked=validation.checked_rules.filter(id=>engine.rule(id)?.severity!=='info');
    const violated=validation.violations.filter(v=>v.severity!=='info').map(v=>v.rule_id);
    const java=checkJava(file,{javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],release:21,
      testSource:join(directory,'AcceptanceTest.java'),testClass:'AcceptanceTest',testArgs:[job.case_id]});
    return {case_id:job.case_id,strategy:job.strategy,repetition:job.repetition,output:'present',call_status:call?.status??'imported',source_hash:digest(code),public_api,
      validation,compliance:validation.status==='complete'?ruleCompliance(checked,violated):null,
      compile:java.compile.status,behavior:java.tests.status,java,
      task:[public_api.status,java.compile.status,java.tests.status].some(s=>s==='failed'||s==='timeout')?'failed':'review_required',usage};
  });
  const summary=(['baseline','rag','tagged']as const).map(strategy=>{
    const selected=records.filter(r=>r.strategy===strategy);
    const measured=selected.flatMap(r=>{
      const u=r.usage as Record<string,unknown>|null;
      return u&&['prompt_tokens','completion_tokens','total_tokens'].every(k=>typeof u[k]==='number'&&Number.isSafeInteger(u[k])&&(u[k]as number)>=0)?[u as Record<string,number>]:[];
    });
    const scored=selected.flatMap(r=>'compliance'in r&&typeof r.compliance==='number'?[r.compliance]:[]);
    return {strategy,planned:selected.length,present:selected.filter(r=>r.output==='present').length,
      compile:outcomeRate(selected.map(r=>r.compile)),behavior:outcomeRate(selected.map(r=>r.behavior)),
      mean_compliance:scored.length?scored.reduce((a,b)=>a+b,0)/scored.length:null,compliance_scored:scored.length,
      all_findings:selected.reduce((n,r)=>n+(r.validation?.stats.violations??0),0),
      error_instances:selected.reduce((n,r)=>n+(r.validation?.violations.filter(v=>v.severity==='error').length??0),0),
      task_failed:selected.filter(r=>r.task==='failed').length,task_completion_rate:null,
      usage_coverage:measured.length,usage_unknown:selected.length-measured.length,
      usage_known_subtotal:measured.length?{prompt_tokens:measured.reduce((n,u)=>n+u['prompt_tokens']!,0),completion_tokens:measured.reduce((n,u)=>n+u['completion_tokens']!,0),total_tokens:measured.reduce((n,u)=>n+u['total_tokens']!,0)}:null,
      currency_cost:null};
  });
  const report={protocol:manifest.protocol,model_requests:execution?.mode==='provider'?calls.size:0,request_attempts:calls.size,
    controlled_model_comparison:!!execution&&issues.length===0,
    provenance:{mode:execution?.mode??'imported',issues,note:'Local traceability, not cryptographic supplier attestation. Task completion still requires independent review.'},
    planned:manifest.jobs.length,present:records.filter(r=>r.output==='present').length,summary,records};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  const rate=(r:ReturnType<typeof outcomeRate>)=>`${r.passed}/${r.total}；已执行 ${r.evaluated}`;
  const rows=summary.map(s=>`| ${s.strategy} | ${s.present}/${s.planned} | ${rate(s.compile)} | ${rate(s.behavior)} | ${s.mean_compliance===null?'未核定':(s.mean_compliance*100).toFixed(1)+'%'} | ${s.all_findings} / ${s.error_instances} | ${s.usage_known_subtotal?.total_tokens??'未知'}（${s.usage_coverage}/${s.planned}） |`).join('\n');
  writeFileSync(markdown,`# 实体标签代码修改实验\n\n受控模型对比：${report.controlled_model_comparison?'记录与哈希核对通过':'未完成或未验证'}；记录的请求尝试 ${report.request_attempts}，其中供应商模式 ${report.model_requests}。输出 ${report.present}/${report.planned}。\n\n${issues.map(i=>'- '+i).join('\n')}\n\n| 策略 | 输出 / 计划 | 编译 | 行为 | 平均静态遵循 | 全部诊断 / error | 已知 total_tokens 小计（覆盖） |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n缺失或未执行项不算已测得的模型失败。usage 小计只包含完整有效记录；未知用量不记 0，不换算未经核实的货币价格。静态诊断不是已确认真实缺陷数。编译和行为通过仍需独立任务审查，完整任务完成率未核定。测试适配器和导入输出不能作为真实供应商生成成绩。本地追溯记录不是供应商签名认证。\n`);
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [directory,output]=process.argv.slice(2);if(!directory||!output)throw new Error('Usage: node eval/tagged-edit/evaluate.ts PREPARED_DIR NEW_REPORT.json');
  const report=evaluateEdits(resolve(directory),resolve(output));console.log(`Evaluated ${report.present}/${report.planned} imported edit outputs; provider usage unknown.`);
}
