/** Reference-only recorder rehearsal. No fetch, credentials, supplier tokens or model generation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from '../../src/api/engine.ts';
import { runTaggedEdits } from './run.ts';

export async function referenceDryRun(prepared:string,output:string) {
  const manifest=JSON.parse(readFileSync(join(prepared,'manifest.json'),'utf8'));
  const report=await runTaggedEdits(prepared,output,{maxCalls:manifest.planned_calls,provider:async request=>{
    const name=request.prompt.match(/public class (BufferedNotifier|EventPublisher|TenantJob)\b/)?.[1];
    if(!name)throw new Error('Unknown reference-only fixture');
    return {model:request.model,code:readFileSync(resolve(REPOSITORY_ROOT,'eval/tagged-edit/references',name+'.java'),'utf8'),
      finish_reason:'stop',usage:undefined,raw_response:{model:request.model,fixture_kind:'Agent-authored reference, not supplier output',reference_class:name},
      applied_parameters:{temperature:request.temperature,max_tokens:request.maxOutputTokens,seed:null,thinking:{type:'disabled'},endpoint:request.apiBase!,api_key_env:request.apiKeyEnv!}};
  }});
  writeFileSync(join(output,'REFERENCE-ONLY.md'),'# 仅参考实现的执行链路演练\n\n三个策略收到相同的 Agent 编写参考源码，未调用供应商或生成模型代码。request_attempts 是测试适配器调用数，model_requests=0；usage 未知，不是实测零 token。controlled_model_comparison=false，不能据此比较策略质量或成本。report 中编译 / 行为通过仅验证记录器与验收链路；完整任务审查仍未完成。\n');
  if(report.model_requests!==0||report.controlled_model_comparison||report.records.some(r=>r.compile!=='ok'||r.behavior!=='ok'))throw new Error('Reference recorder rehearsal failed; artifacts retained');
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [prepared,output]=process.argv.slice(2);if(!prepared||!output)throw new Error('Usage: node eval/tagged-edit/dry-run.ts PREPARED NEW_OUTPUT');
  const report=await referenceDryRun(resolve(prepared),resolve(output));console.log(`Reference-only rehearsal: ${report.present}/${report.planned} outputs; supplier requests ${report.model_requests}; not a model comparison.`);
}
