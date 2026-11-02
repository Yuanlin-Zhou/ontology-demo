/** Prepare only: same edit task/source for baseline, BM25 RAG and entity-tag retrieval. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../../src/api/engine.ts';
import { KnowledgeTree, digest } from '../../src/knowledge/tree.ts';
import { buildGraph, saveGraph } from '../../src/codegraph/graph.ts';
import { retrieveByTags, type PlannedKnowledge } from '../../src/tag-retrieval/retrieve.ts';
import { chunkContext } from '../../src/retrieval/knowledge-payload.ts';
import { estimateTokens } from '../../src/retrieval/token-estimator.ts';

export interface EditSuite {
  version: 1; model: string; temperature: number; maxOutputTokens: number; tokenBudget: number; topK: number; repetitions: number;
  cases: Array<{id:string;file:string;target:string;task:string;facts:string;planned:PlannedKnowledge[]}>;
}
export function prepareEdits(config: string, output: string) {
  if(existsSync(output))throw new Error('Use a fresh output directory; never overwrite a frozen edit experiment');
  const suite:EditSuite=JSON.parse(readFileSync(config,'utf8'));
  if(suite.version!==1||!Number.isSafeInteger(suite.repetitions)||suite.repetitions<1||suite.repetitions>10||!suite.cases.length||
    typeof suite.model!=='string'||!suite.model.trim()||!Number.isFinite(suite.temperature)||suite.temperature<0||suite.temperature>2||
    !Number.isSafeInteger(suite.maxOutputTokens)||suite.maxOutputTokens<1||
    !Number.isSafeInteger(suite.tokenBudget)||suite.tokenBudget<0||!Number.isSafeInteger(suite.topK)||suite.topK<0||
    new Set(suite.cases.map(c=>c.id)).size!==suite.cases.length)throw new Error('Invalid edit suite');
  const engine=RuleEngine.load();const tree=KnowledgeTree.load(REPOSITORY_ROOT,engine.rules());
  const acceptance=readFileSync(resolve(REPOSITORY_ROOT,'eval/tagged-edit/AcceptanceTest.java'),'utf8');
  // Resolve/validate every case before writing any artifacts.
  const inputs=suite.cases.map(c=>{
    if(!/^[A-Z0-9-]+$/.test(c.id))throw new Error('Invalid edit case ID');
    const code=readFileSync(resolve(REPOSITORY_ROOT,c.file),'utf8');
    const graph=buildGraph(engine,tree,c.file,code);
    const targets=graph.entities.filter(e=>e.signature===c.target&&['method','constructor'].includes(e.kind));
    if(targets.length!==1)throw new Error(`Select an unambiguous edit entity: ${c.id}`);
    for(const planned of c.planned){tree.leaf(planned.leaf);if(!planned.reason.trim())throw new Error('Planned capability requires reason');}
    return {c,code,graph,entity:targets[0]!.id};
  });
  mkdirSync(output,{recursive:true});mkdirSync(join(output,'graphs'));mkdirSync(join(output,'inputs'));
  writeFileSync(join(output,'AcceptanceTest.java'),acceptance);
  writeFileSync(join(output,'suite.json'),readFileSync(config,'utf8'));
  const jobs=[];
  for(const {c,code,graph,entity}of inputs) {
    saveGraph(join(output,'graphs',c.id+'.json'),graph);writeFileSync(join(output,'inputs',c.id+'.java'),code);
    const commonTask=`${c.task}\n已知任务条件：${c.facts}\n计划引入的能力：${c.planned.map(p=>p.reason).join('；')||'按现有实体完成指定修改'}`;
    const rag=chunkContext(engine.retrieveChunks(`${commonTask}\n${code}`,{topK:suite.topK,tokenBudget:suite.tokenBudget}));
    const tagged=retrieveByTags(tree,graph,code,{entities:[entity],planned:c.planned,tokenBudget:suite.tokenBudget});
    for(let repetition=1;repetition<=suite.repetitions;repetition++)for(const strategy of ['baseline','rag','tagged']as const) {
      const context=strategy==='baseline'?'':strategy==='rag'?rag:tagged.context;
      const prompt=[`## 修改任务\n${commonTask}`,`## 修改涉及的代码实体\n${entity}`,context,
        `## 当前代码\n\`\`\`java\n${code.trim()}\n\`\`\``,
        '## 统一交付约定\n输出完整单个 Java 源文件，使用 JDK 21 标准库；保留任务指定的公开接口及无关业务。实际执行注入的回调，不用空实现、日志或测试替身冒充业务。只实现本次明确修改。不要输出解释。'].filter(Boolean).join('\n\n');
      const name=`${c.id}-${repetition}.md`;const directory=join(output,'prompts',strategy);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,name),prompt);
      jobs.push({case_id:c.id,repetition,strategy,entity,source_hash:graph.source_hash,common_task_hash:digest(commonTask),prompt_hash:digest(prompt),
        prompt_file:`prompts/${strategy}/${name}`,knowledge_tokens_estimated:estimateTokens(context),
        retrieval:strategy==='tagged'?tagged:null,status:'prepared_not_requested'});
    }
  }
  const manifest={protocol:'entity-tag-edit-v1',prepare_only:true,model_requests:0,quality_results:null,tree_hash:tree.hash,
    acceptance_hash:digest(acceptance),suite_hash:digest(readFileSync(config,'utf8')),config:suite,planned_calls:jobs.length,jobs};
  writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [config,output]=process.argv.slice(2);if(!config||!output)throw new Error('Usage: node eval/tagged-edit/prepare.ts SUITE.json NEW_OUTPUT');
  const manifest=prepareEdits(resolve(config),resolve(output));console.log(`Prepared ${manifest.jobs.length} edit prompts; model requests: 0; quality results: unavailable`);
}
