/** Domain-review workflow: no supplier calls, no engine-generated gold labels. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../../src/api/engine.ts';
import { KnowledgeTree, digest } from '../../src/knowledge/tree.ts';
import { buildGraph } from '../../src/codegraph/graph.ts';
import { retrieveByTags } from '../../src/tag-retrieval/retrieve.ts';
import { implementationHashes } from '../tagged-edit/artifacts.ts';

interface Candidate {id:string;file:string;target:string;task:string;facts:string;planned:unknown[];policy:string;assessment:string}
interface Suite {version:1;origin:string;independent_holdout:boolean;requires_external_review:boolean;tokenBudget:number;cases:Candidate[]}
interface Guide {version:1;entries:Array<{leaf:string;kind:string;question:string;include_when:string[];exclude_or_review:string[];needed_facts:string[];status:string}>}
type Decision='required'|'helpful'|'irrelevant'|'uncertain';
export interface ReviewLabels {
  schema:1;package_hash:string;
  reviewer:{identity:string;kind:string;independent_of_engine_development:boolean|null;not_task_author:boolean|null;no_predictions_seen:boolean|null;leaf_definitions_reviewed:boolean|null};
  cases:Array<{id:string;source_hash:string;leaves:Array<{leaf:string;decision:Decision|null;evidence:string;evidence_entities:string[]}>}>;
}
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const write=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
const relativePath=(file:string)=>{if(typeof file!=='string'||!file||isAbsolute(file)||file.split(/[\\/]/).includes('..'))throw new Error('Project-relative path required');return file;};
function context(){const engine=RuleEngine.load();return {engine,tree:KnowledgeTree.load(REPOSITORY_ROOT,engine.rules())};}
const packetHash=(m:{schema:number;origin:string;declared_independent_holdout:boolean;tree_hash:string;tokenBudget:number;files:Record<string,string>})=>
  digest(JSON.stringify({schema:m.schema,origin:m.origin,declared_independent_holdout:m.declared_independent_holdout,tree_hash:m.tree_hash,tokenBudget:m.tokenBudget,files:m.files}));
export function prepareReview(config:string,output:string) {
  if(existsSync(output))throw new Error('Use a fresh review package directory');
  const suite:Suite=json(config);const {engine,tree}=context();
  if(suite.version!==1||typeof suite.origin!=='string'||!suite.origin.trim()||typeof suite.independent_holdout!=='boolean'||!Number.isSafeInteger(suite.tokenBudget)||suite.tokenBudget<0||!suite.cases.length||
    new Set(suite.cases.map(c=>c.id)).size!==suite.cases.length)throw new Error('Invalid candidate suite');
  const guide:Guide=json(resolve(REPOSITORY_ROOT,'eval/entity-review/leaf-guide.json'));
  if(guide.version!==1||guide.entries.length!==tree.leaves.length||new Set(guide.entries.map(g=>g.leaf)).size!==tree.leaves.length)throw new Error('Incomplete leaf review guide');
  for(const g of guide.entries)if(tree.leaf(g.leaf).kind!==g.kind||!g.question||[g.include_when,g.exclude_or_review,g.needed_facts].some(a=>!a.length))throw new Error('Invalid semantic leaf guide');
  const inputs=suite.cases.map(c=>{
    if(!/^[A-Z0-9-]+$/.test(c.id)||!Array.isArray(c.planned)||c.planned.length)throw new Error('Existing-tag cohort forbids planned knowledge');
    const source=readFileSync(resolve(REPOSITORY_ROOT,relativePath(c.file)),'utf8');const graph=buildGraph(engine,tree,c.file,source);
    const selected=graph.entities.filter(e=>e.kind==='method'&&(c.target.includes('::')?e.id.endsWith('#'+c.target):e.signature===c.target));if(selected.length!==1)throw new Error('Ambiguous candidate target');
    const retrieval=retrieveByTags(tree,graph,source,{entities:[selected[0]!.id],tokenBudget:suite.tokenBudget});
    if(!Object.keys(retrieval.provenance).length||Object.values(retrieval.provenance).flat().some(p=>p.via==='planned'))throw new Error('Candidate must exercise existing entity tags');
    return {c,source,graph,retrieval,entity:selected[0]!.id};
  });
  mkdirSync(output,{recursive:true});const packet=join(output,'reviewer');
  const paths:string[]=[];
  const publicFile=(name:string,value:unknown)=>{write(join(packet,name),value);paths.push(name);};
  publicFile('leaf-catalog.json',tree.leaves.map(l=>({id:l.id,title:l.title,path:tree.path(l.id),kind:l.kind,content:l.content,sources:l.sources,
    review_guide:guide.entries.find(g=>g.leaf===l.id)})));
  const publicCases=inputs.map(({c,source,graph,entity})=>({id:c.id,source_file:`inputs/${c.id}/${basename(c.file)}`,source_hash:digest(source),task:c.task,facts:c.facts,
    target:entity,policy:c.policy,assessment:c.assessment,
    entities:graph.entities.map(e=>({id:e.id,kind:e.kind,signature:e.signature,line:e.line,endLine:e.endLine}))}));
  publicFile('tasks.json',publicCases);
  for(const i of inputs)publicFile(`inputs/${i.c.id}/${basename(i.c.file)}`,i.source);
  for(const source of [...new Set(tree.leaves.flatMap(l=>l.sources!))])publicFile('sources/'+source,readFileSync(resolve(REPOSITORY_ROOT,source),'utf8'));
  publicFile('README.md','# 领域评审包\n\n仅阅读本目录中的任务、源码、知识目录与原文档。请不要查看同级 engine/ 的预测或运行引擎后再填写；若已经看到预测，请如实声明，不能作为盲于预测的独立基线。知识指南也是 Agent 草案，需要领域确认。\n\n把 annotations.template.json 复制到本目录之外填写。每个任务对全部叶子标 required / helpful / irrelevant / uncertain，并写依据；required / helpful 需关联本任务公开实体列表中的证据实体。不确定不能当作无关。引擎特征、标签和召回结果不包含在本包。身份与独立性声明只记录，不构成身份认证。\n');
  const files=Object.fromEntries(paths.sort().map(p=>[p,digest(readFileSync(join(packet,p),'utf8'))]));
  const binding={schema:1,origin:suite.origin,declared_independent_holdout:suite.independent_holdout,tree_hash:tree.hash,tokenBudget:suite.tokenBudget,files};
  const manifest={...binding,independent_holdout_verified:false,package_hash:packetHash(binding),model_requests:0};
  write(join(packet,'packet-manifest.json'),manifest);
  const template:ReviewLabels={schema:1,package_hash:manifest.package_hash,reviewer:{identity:'',kind:'',independent_of_engine_development:null,not_task_author:null,no_predictions_seen:null,leaf_definitions_reviewed:null},
    cases:publicCases.map(c=>({id:c.id,source_hash:c.source_hash,leaves:tree.leaves.map(l=>({leaf:l.id,decision:null,evidence:'',evidence_entities:[]}))}))};
  write(join(packet,'annotations.template.json'),template);
  for(const i of inputs)write(join(output,'engine/graphs',i.c.id+'.json'),i.graph);
  write(join(output,'engine/predictions.json'),{model_requests:0,note:'Engine predictions, not gold. Do not expose to the reviewer before sealing.',cases:inputs.map(i=>({id:i.c.id,entity:i.entity,retrieval:i.retrieval}))});
  write(join(output,'engine/implementation.json'),{engine:implementationHashes(),review_workflow_hash:digest(readFileSync(import.meta.filename,'utf8'))});
  write(join(output,'engine/correspondence.md'),'# 实体—知识—候选修改任务对应表（引擎预测，非标准答案）\n\n| 任务 | 修改实体 | 预算内预测叶子 | 独立标注 |\n| --- | --- | --- | --- |\n'+inputs.map(i=>`| ${i.c.id} | ${i.entity} | ${i.retrieval.selected_leaf_ids.join(', ')} | 待填写 |`).join('\n')+'\n\n公共评审包不包含本表；不能用这些预测回填标准答案。\n');
  write(join(output,'review-state.json'),{model_requests:0,status:'awaiting_external_review',metrics:null,independent_holdout_verified:false,origin:suite.origin});
  return manifest;
}

function readPacket(packet:string) {
  const manifest=json(join(packet,'packet-manifest.json'));const {engine,tree}=context();
  if(manifest.schema!==1||manifest.tree_hash!==tree.hash||manifest.package_hash!==packetHash(manifest))throw new Error('Review package/knowledge changed');
  for(const [file,hash]of Object.entries(manifest.files))if(digest(readFileSync(join(packet,relativePath(file)),'utf8'))!==hash)throw new Error('Frozen review source changed');
  const cases:Array<{id:string;source_file:string;source_hash:string;target:string;entities:Array<{id:string}>}>=json(join(packet,'tasks.json'));
  for(const c of cases)if(digest(readFileSync(join(packet,c.source_file),'utf8'))!==c.source_hash)throw new Error('Review source changed');
  return {manifest,engine,tree,cases};
}
function validateLabels(packet:string,labels:ReviewLabels) {
  const data=readPacket(packet);const {tree,cases,manifest}=data;
  if(labels.schema!==1||labels.package_hash!==manifest.package_hash)throw new Error('Review bound to another package');
  const r=labels.reviewer;
  if(r.kind!=='domain_reviewer'||!r.identity.trim()||r.independent_of_engine_development!==true||r.not_task_author!==true||r.no_predictions_seen!==true||r.leaf_definitions_reviewed!==true)throw new Error('External domain review and explicit independence declarations required');
  if(labels.cases.length!==cases.length||new Set(labels.cases.map(c=>c.id)).size!==cases.length)throw new Error('Incomplete case review');
  for(const c of cases) {
    const reviewed=labels.cases.find(x=>x.id===c.id);if(!reviewed||reviewed.source_hash!==c.source_hash||reviewed.leaves.length!==tree.leaves.length||new Set(reviewed.leaves.map(l=>l.leaf)).size!==tree.leaves.length)throw new Error('Incomplete or stale leaf review');
    for(const leaf of reviewed.leaves) {
      tree.leaf(leaf.leaf);
      if(!['required','helpful','irrelevant','uncertain'].includes(leaf.decision??'')||!leaf.evidence.trim())throw new Error('Unfilled/unsupported relevance label');
      if(!Array.isArray(leaf.evidence_entities)||leaf.evidence_entities.some(id=>!c.entities.some(e=>e.id===id))||
        (['required','helpful'].includes(leaf.decision!)&&!leaf.evidence_entities.length))throw new Error('Relevant leaves require valid source entity evidence');
    }
  }
  return data;
}
export function sealReview(packet:string,annotations:string,output:string) {
  if(existsSync(output))throw new Error('Use a fresh seal path');const labels:ReviewLabels=json(annotations);validateLabels(packet,labels);
  const sealed={schema:'entity-leaf-review-v1',package_hash:labels.package_hash,labels_hash:digest(JSON.stringify(labels)),
    independence:'reviewer_declared_not_authenticated',labels};write(output,sealed);return sealed;
}
function relevance(ids:string[],leaves:ReviewLabels['cases'][number]['leaves']) {
  const selected=new Set(ids);const required=leaves.filter(l=>l.decision==='required');
  const relevant=leaves.filter(l=>selected.has(l.leaf)&&['required','helpful'].includes(l.decision!)).length;
  const irrelevant=leaves.filter(l=>selected.has(l.leaf)&&l.decision==='irrelevant').length;
  const hit=required.filter(l=>selected.has(l.leaf)).length;
  return {selected:ids.length,relevant_selected:relevant,irrelevant_selected:irrelevant,uncertain_selected:leaves.filter(l=>selected.has(l.leaf)&&l.decision==='uncertain').length,
    precision_decided:relevant+irrelevant?relevant/(relevant+irrelevant):null,required_total:required.length,required_hit:hit,
    required_recall:required.length?hit/required.length:null,missing_required:required.filter(l=>!selected.has(l.leaf)).map(l=>l.leaf)};
}
export function scoreReview(packet:string,sealFile:string,output:string) {
  if(existsSync(output))throw new Error('Use a fresh metrics path');const seal=json(sealFile);
  if(seal.schema!=='entity-leaf-review-v1'||seal.independence!=='reviewer_declared_not_authenticated'||seal.labels_hash!==digest(JSON.stringify(seal.labels))||seal.package_hash!==seal.labels.package_hash)throw new Error('Sealed review changed');
  const {manifest,engine,tree,cases}=validateLabels(packet,seal.labels);
  const results=cases.map(c=>{
    const source=readFileSync(join(packet,c.source_file),'utf8');
    const originalFile=c.target.split('#')[0]!;const graph=buildGraph(engine,tree,originalFile,source);
    const retrieval=retrieveByTags(tree,graph,source,{entities:[c.target],tokenBudget:manifest.tokenBudget});
    const leaves:ReviewLabels['cases'][number]['leaves']=seal.labels.cases.find((r:{id:string})=>r.id===c.id).leaves;
    return {id:c.id,source_hash:c.source_hash,unbudgeted:relevance(Object.keys(retrieval.provenance),leaves),budgeted:relevance(retrieval.selected_leaf_ids,leaves),
      dropped_required:leaves.filter(l=>l.decision==='required'&&retrieval.dropped_leaf_ids.includes(l.leaf)).map(l=>l.leaf),
      anchor_review:leaves.filter(l=>['required','helpful'].includes(l.decision!)).map(l=>({leaf:l.leaf,evidence_entities:l.evidence_entities,
        engine_source_entities:(retrieval.provenance[l.leaf]??[]).map(p=>p.entity).filter(Boolean)})),retrieval};
  });
  const report={schema:1,model_requests:0,status:'scored_against_declared_domain_review',origin:manifest.origin,
    package_hash:manifest.package_hash,sealed_review_hash:digest(readFileSync(sealFile,'utf8')),engine_implementation:implementationHashes(),review_workflow_hash:digest(readFileSync(import.meta.filename,'utf8')),
    independent_holdout_verified:false,independence:seal.independence,full_entity_tag_accuracy:null,
    note:'Task-relevant leaf retrieval only; uncertain labels excluded from precision. Entity anchors are review evidence, not an exhaustive edge-accuracy benchmark. No model quality measured.',results};
  write(output,report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [command,a,b,c,...extra]=process.argv.slice(2);
  if(extra.length)throw new Error('Unexpected arguments');
  if(command==='prepare'&&a&&b&&!c)prepareReview(resolve(a),resolve(b));
  else if(command==='seal'&&a&&b&&c)sealReview(resolve(a),resolve(b),resolve(c));
  else if(command==='score'&&a&&b&&c)scoreReview(resolve(a),resolve(b),resolve(c));
  else throw new Error('Usage: workflow.ts prepare SUITE NEW_DIR | seal REVIEWER_DIR FILLED_LABELS NEW_SEAL | score REVIEWER_DIR SEALED NEW_METRICS');
}
