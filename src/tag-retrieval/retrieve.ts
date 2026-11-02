import { assertFresh, type CodeGraph, type EntityTag } from '../codegraph/graph.ts';
import { KnowledgeTree } from '../knowledge/tree.ts';
import { estimateTokens } from '../retrieval/token-estimator.ts';

export interface PlannedKnowledge { leaf: string; reason: string }
export function retrieveByTags(tree: KnowledgeTree, graph: CodeGraph, code: string, input: {
  entities: string[]; planned?: PlannedKnowledge[]; tokenBudget?: number;
}) {
  assertFresh(graph,tree,code);
  const budget=input.tokenBudget??1200;
  if(!Number.isSafeInteger(budget)||budget<0||!input.entities.length)throw new Error('Require selected entities and nonnegative integer budget');
  const visited=new Map<string,{depth:number;via:string}>();
  for(const id of input.entities) {
    if(!graph.entities.some(e=>e.id===id))throw new Error(`Unknown entity: ${id}`);
    visited.set(id,{depth:0,via:'selected'});
  }
  // Bounded two-hop file-local traversal, never containment fan-out or reverse callers.
  for(let depth=0;depth<2;depth++)for(const [id,entry]of [...visited]) {
    if(entry.depth!==depth)continue;
    for(const edge of graph.edges.filter(e=>e.from===id&&e.kind!=='contains'))if(!visited.has(edge.to))visited.set(edge.to,{depth:depth+1,via:`${id} --${edge.kind}--> ${edge.to}`});
  }
  const candidates=new Map<string,Array<{entity?:string;via:string;tag?:EntityTag;reason?:string}>>();
  for(const planned of input.planned??[]) {
    tree.leaf(planned.leaf);if(!planned.reason.trim())throw new Error('Planned knowledge requires explicit reason');
    const entries=candidates.get(planned.leaf)??[];entries.push({via:'planned',reason:planned.reason});candidates.set(planned.leaf,entries);
  }
  for(const [id,entry]of visited)for(const tag of graph.entities.find(e=>e.id===id)!.tags) {
    tree.leaf(tag.leaf);const entries=candidates.get(tag.leaf)??[];entries.push({entity:id,via:entry.via,tag});candidates.set(tag.leaf,entries);
  }
  const render=(ids:string[])=>ids.length ? '## 按代码实体标签召回的知识\n'+ids.map(id=>{
    const n=tree.leaf(id);return `### ${id} ${tree.path(id).join(' / ')} [${n.kind==='decision'?'决策知识':'编码规范'}]\n${n.content}\n关联规则：${n.rule_ids!.join(', ')||'需结合任务条件判断'}\n来源：${n.sources!.join(', ')}`;
  }).join('\n\n'):'';
  const selected:string[]=[],dropped:string[]=[];
  for(const id of candidates.keys()) {
    if(estimateTokens(render([...selected,id]))<=budget)selected.push(id);else dropped.push(id);
  }
  return {context:render(selected),estimated_tokens:estimateTokens(render(selected)),selected_leaf_ids:selected,dropped_leaf_ids:dropped,
    entities:[...visited].map(([id,trace])=>({id,...trace})),
    provenance:Object.fromEntries([...candidates]),tree_hash:tree.hash,source_hash:graph.source_hash,
    warnings:dropped.length?['Knowledge budget omitted leaves; retrieval is not complete coverage.']:[]};
}
