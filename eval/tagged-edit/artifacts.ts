/** Reconstruct frozen retrieval and prompts rather than trusting editable manifest counters. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuleEngine, REPOSITORY_ROOT } from '../../src/api/engine.ts';
import { KnowledgeTree, digest } from '../../src/knowledge/tree.ts';
import { buildGraph } from '../../src/codegraph/graph.ts';
import { retrieveByTags } from '../../src/tag-retrieval/retrieve.ts';
import { chunkContext } from '../../src/retrieval/knowledge-payload.ts';
import { estimateTokens } from '../../src/retrieval/token-estimator.ts';
import { editTask, editPrompt, type prepareEdits } from './prepare.ts';

export type EditManifest=ReturnType<typeof prepareEdits>;
export type EditJob=EditManifest['jobs'][number];
export const jobKey=(job:Pick<EditJob,'strategy'|'case_id'|'repetition'>)=>`${job.strategy}/${job.case_id}-${job.repetition}`;
export function readPrepared(directory:string) {
  const manifest:EditManifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  if(manifest.protocol!=='entity-tag-edit-v1'||manifest.model_requests!==0||!manifest.prepare_only)throw new Error('Unsupported edit manifest');
  const engine=RuleEngine.load();const tree=KnowledgeTree.load(REPOSITORY_ROOT,engine.rules());
  const config=JSON.parse(readFileSync(join(directory,'suite.json'),'utf8'));
  if(tree.hash!==manifest.tree_hash||digest(readFileSync(join(directory,'AcceptanceTest.java'),'utf8'))!==manifest.acceptance_hash||
    digest(readFileSync(join(directory,'suite.json'),'utf8'))!==manifest.suite_hash||JSON.stringify(config)!==JSON.stringify(manifest.config))throw new Error('Frozen inputs/knowledge changed');
  if(config.version!==1||!Array.isArray(config.cases)||!Number.isSafeInteger(config.repetitions)||config.repetitions<1||config.repetitions>10||
    !Number.isSafeInteger(config.tokenBudget)||config.tokenBudget<0||!Number.isSafeInteger(config.topK)||config.topK<0||
    typeof config.model!=='string'||!config.model.trim()||!Number.isFinite(config.temperature)||config.temperature<0||config.temperature>2||
    !Number.isSafeInteger(config.maxOutputTokens)||config.maxOutputTokens<1||new Set(config.cases.map((c:{id:string})=>c.id)).size!==config.cases.length)throw new Error('Invalid frozen suite');
  const expected:EditManifest['jobs']=[];
  for(const c of manifest.config.cases) {
    if(!/^[A-Z0-9-]+$/.test(c.id))throw new Error('Invalid frozen case ID');
    const code=readFileSync(join(directory,'inputs',c.id+'.java'),'utf8');
    const graph=buildGraph(engine,tree,c.file,code);
    if(JSON.stringify(graph)!==JSON.stringify(JSON.parse(readFileSync(join(directory,'graphs',c.id+'.json'),'utf8'))))throw new Error('Frozen graph changed');
    const targets=graph.entities.filter(e=>e.signature===c.target&&['method','constructor'].includes(e.kind));
    if(targets.length!==1)throw new Error('Invalid frozen target');
    const entity=targets[0]!.id,task=editTask(c);
    const rag=chunkContext(engine.retrieveChunks(`${task}\n${code}`,{topK:config.topK,tokenBudget:config.tokenBudget}));
    const tagged=retrieveByTags(tree,graph,code,{entities:[entity],planned:c.planned,tokenBudget:config.tokenBudget});
    for(let repetition=1;repetition<=config.repetitions;repetition++)for(const strategy of ['baseline','rag','tagged']as const) {
      const prompt=editPrompt(task,entity,code,strategy==='baseline'?'':strategy==='rag'?rag:tagged.context);
      const prompt_file=`prompts/${strategy}/${c.id}-${repetition}.md`;
      if(readFileSync(join(directory,prompt_file),'utf8')!==prompt)throw new Error('Frozen prompt changed');
      const job=manifest.jobs.find(j=>jobKey(j)===`${strategy}/${c.id}-${repetition}`);
      if(!job||job.prompt_file!==prompt_file||job.prompt_hash!==digest(prompt)||job.source_hash!==digest(code)||
        job.common_task_hash!==digest(task)||job.entity!==entity||job.status!=='prepared_not_requested'||
        job.knowledge_tokens_estimated!==estimateTokens(strategy==='baseline'?'':strategy==='rag'?rag:tagged.context)||
        JSON.stringify(job.retrieval)!==JSON.stringify(strategy==='tagged'?tagged:null))throw new Error('Frozen job changed');
      expected.push(job);
    }
  }
  if(!expected.length||expected.length!==manifest.jobs.length||manifest.planned_calls!==expected.length||expected.some((j,i)=>jobKey(j)!==jobKey(manifest.jobs[i]!)))throw new Error('Frozen job matrix/order changed');
  return {manifest,engine};
}

export function implementationHashes():Record<string,string> {
  const files=(directory:string):string[]=>readdirSync(resolve(REPOSITORY_ROOT,directory),{withFileTypes:true}).flatMap(e=>
    e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]);
  const names=['src','knowledge','knowledge-tree'].flatMap(files).concat([
    'eval/tagged-edit/prepare.ts','eval/tagged-edit/artifacts.ts','eval/tagged-edit/run.ts','eval/tagged-edit/evaluate.ts','eval/tagged-edit/dry-run.ts',
    'eval/java.ts','eval/model-output.ts','eval/api-compatibility.ts','eval/metrics.ts','eval/providers/openai-compatible.ts']);
  return Object.fromEntries(names.sort().map(f=>[f,digest(readFileSync(resolve(REPOSITORY_ROOT,f),'utf8'))]));
}
