/** Explicit-budget provider execution. Never runs on import; no retries or paid Repair. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../../src/knowledge/tree.ts';
import { completeRequest, type Request } from '../providers/openai-compatible.ts';
import { extractJavaSource } from '../model-output.ts';
import { implementationHashes, jobKey, readPrepared, type EditJob } from './artifacts.ts';
import { evaluateEdits } from './evaluate.ts';

export type ProviderReply=Awaited<ReturnType<typeof completeRequest>>;
export interface EditCall {
  key:string; prompt_hash:string; status:'started'|'ok'|'invalid_output'|'failed';
  model_requested:string; model_returned?:string; elapsed_ms?:number;
  usage?:unknown; applied_parameters?:unknown; failure?:string;
  raw_hash?:string; source_hash?:string; extraction?:string;
}
export interface EditExecution {
  protocol:'entity-tag-execution-v1'; mode:'provider'|'test_adapter'; status:'running'|'complete'|'provider_failed'|'invalidated';
  prepared_manifest_hash:string; max_calls:number; planned_calls:number; request_attempts:number;
  implementation:Record<string,string>; call_hashes:Record<string,string>;
  provider:{endpoint:string;api_key_env:string};
}
export const callFile=(directory:string,job:EditJob)=>join(directory,'calls',jobKey(job)+'.json');
export async function runTaggedEdits(prepared:string,output:string,options:{maxCalls:number;provider?:(request:Request)=>Promise<ProviderReply>}) {
  const {manifest}=readPrepared(prepared);
  if(options.maxCalls!==manifest.jobs.length)throw new Error('Explicit maxCalls must equal the complete planned matrix; no extra/retry budget');
  if(existsSync(output))throw new Error('Use a fresh execution directory');
  if(['execution.json','results','calls'].some(f=>existsSync(join(prepared,f))))throw new Error('Cannot execute a directory with prior/imported outputs');
  if(!options.provider&&!process.env['EVAL_API_KEY'])throw new Error('Configure EVAL_API_KEY for DeepSeek before execution');
  const implementation=implementationHashes();
  mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
  for(const file of ['manifest.json','suite.json','AcceptanceTest.java','graphs','inputs','prompts'])cpSync(join(prepared,file),join(output,file),{recursive:true});
  const execution:EditExecution={protocol:'entity-tag-execution-v1',mode:options.provider?'test_adapter':'provider',status:'running',
    prepared_manifest_hash:digest(readFileSync(join(output,'manifest.json'),'utf8')),max_calls:options.maxCalls,planned_calls:manifest.jobs.length,request_attempts:0,
    implementation,call_hashes:{},provider:{endpoint:'https://api.deepseek.com/chat/completions',api_key_env:'EVAL_API_KEY'}};
  const json=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
  const saveExecution=()=>json(join(output,'execution.json'),execution);
  const record=(job:EditJob,call:EditCall)=>{
    json(callFile(output,job),call);execution.call_hashes[jobKey(job)]=digest(readFileSync(callFile(output,job),'utf8'));saveExecution();
  };
  const verify=()=>{
    readPrepared(output);
    if(execution.prepared_manifest_hash!==digest(readFileSync(join(output,'manifest.json'),'utf8'))||
      JSON.stringify(implementationHashes())!==JSON.stringify(implementation))throw new Error('Inputs/implementation changed during execution');
    for(const job of manifest.jobs) {
      const hash=execution.call_hashes[jobKey(job)];if(!hash)continue;
      const path=callFile(output,job);if(digest(readFileSync(path,'utf8'))!==hash)throw new Error('Call changed');
      const call:EditCall=JSON.parse(readFileSync(path,'utf8'));
      if(call.source_hash&&digest(readFileSync(join(output,'results',jobKey(job)+'.java'),'utf8'))!==call.source_hash)throw new Error('Generated source changed');
      if(call.raw_hash&&digest(readFileSync(join(output,'raw',jobKey(job)+'.json'),'utf8'))!==call.raw_hash)throw new Error('Raw response changed');
    }
  };
  saveExecution();
  try{
    for(const job of manifest.jobs) {
      verify();
      const call:EditCall={key:jobKey(job),prompt_hash:job.prompt_hash,status:'started',model_requested:manifest.config.model};
      execution.request_attempts++;record(job,call);
      const start=Date.now();let reply:ProviderReply;
      try{
        reply=await (options.provider??completeRequest)({model:manifest.config.model,temperature:manifest.config.temperature,maxOutputTokens:manifest.config.maxOutputTokens,
          seed:42,sendSeed:false,apiBase:execution.provider.endpoint,apiKeyEnv:execution.provider.api_key_env,prompt:readFileSync(join(output,job.prompt_file),'utf8')});
      }catch(error){
        const status=String(error).match(/HTTP (\d{3})/)?.[1];
        call.status='failed';call.elapsed_ms=Date.now()-start;
        call.failure=status?`Provider request failed (HTTP ${status}); no retries.`:'Provider request failed; details omitted to avoid credential leakage; no retries.';
        execution.status='provider_failed';record(job,call);break;
      }
      call.elapsed_ms=Date.now()-start;call.model_returned=reply.model;call.usage=reply.usage;call.applied_parameters=reply.applied_parameters;
      const raw=join(output,'raw',jobKey(job)+'.json');json(raw,reply);call.raw_hash=digest(readFileSync(raw,'utf8'));
      if(reply.model!==manifest.config.model){call.status='failed';call.failure='Returned model differs from frozen requested model';execution.status='provider_failed';record(job,call);break;}
      try{
        if(reply.finish_reason!=='stop')throw new Error('Incomplete generation');
        const extracted=extractJavaSource(reply.code);
        const file=join(output,'results',jobKey(job)+'.java');mkdirSync(dirname(file),{recursive:true});writeFileSync(file,extracted.code);
        call.status='ok';call.source_hash=extracted.source_sha256;call.extraction=extracted.format;
      }catch{
        call.status='invalid_output';call.failure='Incomplete or ambiguous Java transport output; raw response retained without repairing source';
      }
      record(job,call);
    }
    verify();if(execution.status==='running')execution.status='complete';saveExecution();
  }catch{
    execution.status='invalidated';saveExecution();
    throw new Error('Execution invalidated by artifact/implementation changes; saved attempts retained, no automatic retry');
  }
  // Preserve prepared manifest verbatim. Execution records, not relabelling, establish attempted calls.
  return evaluateEdits(output,join(output,'report.json'));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [prepared,output,flag,budget,execute,...extra]=process.argv.slice(2);
  if(!prepared||!output||flag!=='--max-calls'||!budget||execute!=='--execute'||extra.length)throw new Error('Usage: node --use-env-proxy eval/tagged-edit/run.ts PREPARED NEW_OUTPUT --max-calls N --execute');
  const report=await runTaggedEdits(resolve(prepared),resolve(output),{maxCalls:Number(budget)});
  console.log(`Attempts ${report.request_attempts}; present ${report.present}/${report.planned}; controlled ${report.controlled_model_comparison}`);
  if(!report.controlled_model_comparison)process.exitCode=1;
}
