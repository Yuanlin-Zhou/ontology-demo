import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { RuleEngine } from '../api/engine.ts';
import { JavaSymbols, enclosing, isWithin } from '../analyzer/java-symbols.ts';
import { childForField, walk } from '../analyzer/ast-utils.ts';
import type { JavaSyntaxNode } from '../analyzer/java-parser.ts';
import type { FeatureHit } from '../domain/types.ts';
import { KnowledgeTree, digest } from '../knowledge/tree.ts';

export const TAGGER_VERSION = 1;
export interface EntityTag {
  leaf: string; origin: 'ast' | 'manual' | 'aggregate'; feature?: string;
  evidence: string; line: number; column: number; from_entity?: string;
  confidence?: FeatureHit['confidence']; attributes?: FeatureHit['attributes'];
}
export interface CodeEntity {
  id: string; kind: 'class' | 'interface' | 'method' | 'constructor' | 'field';
  name: string; signature: string; start: number; end: number; line: number; endLine: number;
  parent?: string; tags: EntityTag[];
}
export interface CodeGraph {
  schema: 1; tagger: number; tree_hash: string; file: string; source_hash: string;
  entities: CodeEntity[];
  edges: Array<{ from: string; to: string; kind: 'contains' | 'uses' | 'calls' }>;
}
export interface ManualTag { entity: string; leaf: string; reason: string }
const TYPES = ['class_declaration','interface_declaration','enum_declaration','record_declaration'];
const CALLABLES = ['method_declaration','constructor_declaration'];

export function buildGraph(engine: RuleEngine, tree: KnowledgeTree, file: string, code: string, manual: ManualTag[] = []): CodeGraph {
  if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Graph file must be a project-relative path');
  file = file.replaceAll('\\','/');
  const analysis = engine.analyze({ code, filePath: file });
  if (analysis.parsed.errors.length) throw new Error('Cannot tag Java with syntax errors; prior graph remains stale');
  const symbols = new JavaSymbols(analysis.parsed.rootNode);
  const pkg = analysis.parsed.rootNode.namedChildren.find(n => n.type === 'package_declaration')?.text.replace(/^package\s+|;$/g,'').trim();
  const entries: Array<{ entity: CodeEntity; node: JavaSyntaxNode }> = [];
  const owners = (n: JavaSyntaxNode): string => {
    const names: string[] = [];
    for (let p = n.parent; p; p = p.parent) if (TYPES.includes(p.type)) names.unshift(childForField(p,'name')?.text ?? '');
    return [pkg,...names].filter(Boolean).join('.');
  };
  walk(analysis.parsed.rootNode, node => {
    const field = node.type === 'variable_declarator' && node.parent?.type === 'field_declaration';
    if (!TYPES.includes(node.type) && !CALLABLES.includes(node.type) && !field) return;
    // Anonymous/local implementation member resolution is outside this lightweight graph.
    if (enclosing(node,['class_body'])?.parent?.type === 'object_creation_expression') return;
    const name = childForField(node,'name')?.text;
    if (!name) return;
    const type = TYPES.includes(node.type);
    const constructor = node.type === 'constructor_declaration';
    const kind: CodeEntity['kind'] = type ? node.type === 'interface_declaration' ? 'interface' : 'class' : field ? 'field' : constructor ? 'constructor' : 'method';
    const params = (childForField(node,'parameters')?.namedChildren ?? []).filter(p => ['formal_parameter','spread_parameter'].includes(p.type))
      .map(p => `${childForField(p,'type')?.text ?? p.namedChildren.find(c=>c.type.includes('type'))?.text ?? '?'}${p.type==='spread_parameter'?'...':''}${childForField(p,'dimensions')?.text ?? ''}`.replace(/\s+/g,''));
    const signature = type ? name : field ? `field:${name}` : `${constructor?'<init>':name}(${params.join(',')})`;
    const owner = owners(node);
    const id = `${file}#${type ? [owner,name].filter(Boolean).join('.') : owner+'::'+signature}`;
    if (entries.some(e => e.entity.id === id)) throw new Error(`Ambiguous entity identity: ${id}`);
    entries.push({node,entity:{id,kind,name,signature,start:node.startIndex,end:node.endIndex,
      line:node.startPosition.row+1,endLine:node.endPosition.row+1,tags:[]}});
  });
  const edges: CodeGraph['edges'] = [];
  const addEdge = (from: string,to: string,kind: CodeGraph['edges'][number]['kind']) => {
    if (from !== to && !edges.some(e=>e.from===from&&e.to===to&&e.kind===kind)) edges.push({from,to,kind});
  };
  for (const entry of entries) {
    const parent = entries.filter(e => e.node.id !== entry.node.id && isWithin(entry.node,e.node)).sort((a,b)=>(a.node.endIndex-a.node.startIndex)-(b.node.endIndex-b.node.startIndex))[0];
    if(parent){entry.entity.parent=parent.entity.id;addEdge(parent.entity.id,entry.entity.id,'contains');}
    if(['class','interface'].includes(entry.entity.kind))continue;
    for (const node of symbols.nodes.filter(n=>isWithin(n,entry.node))) {
      const field = symbols.lookup(node);
      const target = field?.field && entries.find(e=>e.node.id===field.declaration.id);
      if(target)addEdge(entry.entity.id,target.entity.id,'uses');
      if(node.type==='method_invocation') {
        const method = symbols.method(node);
        const called = method && entries.find(e=>e.node.id===method.id);
        if(called)addEdge(entry.entity.id,called.entity.id,'calls');
      }
    }
  }
  const offset = (hit: FeatureHit) => {
    const lines=code.split('\n');return lines.slice(0,hit.startLine-1).reduce((n,l)=>n+l.length+1,0)+hit.startColumn-1;
  };
  for (const hit of analysis.hits) {
    const at=offset(hit);
    const owner=entries.filter(e=>at>=e.node.startIndex&&at<e.node.endIndex).sort((a,b)=>(a.node.endIndex-a.node.startIndex)-(b.node.endIndex-b.node.startIndex))[0];
    if(!owner)continue;
    for(const leaf of tree.leaves.filter(l=>l.any_features!.includes(hit.feature)&&
      Object.entries(l.attributes??{}).every(([key,values])=>values.includes(hit.attributes[key]!)))) {
      owner.entity.tags.push({leaf:leaf.id,origin:'ast',feature:hit.feature,evidence:hit.snippet,line:hit.startLine,column:hit.startColumn,confidence:hit.confidence,attributes:hit.attributes});
    }
  }
  for(const tag of manual) {
    const entity=entries.find(e=>e.entity.id===tag.entity)?.entity;tree.leaf(tag.leaf);
    if(!entity||!tag.reason.trim())throw new Error('Manual tag requires exact entity and justification');
    entity.tags.push({leaf:tag.leaf,origin:'manual',evidence:tag.reason,line:entity.line,column:1});
  }
  // Type tags are summaries. Method retrieval never inherits every tag from its containing class.
  for(const entry of [...entries].sort((a,b)=>(a.node.endIndex-a.node.startIndex)-(b.node.endIndex-b.node.startIndex))) {
    const parent=entries.find(e=>e.entity.id===entry.entity.parent)?.entity;
    if(parent&&['class','interface'].includes(parent.kind))for(const tag of entry.entity.tags)parent.tags.push({...tag,origin:'aggregate',from_entity:entry.entity.id});
  }
  return {schema:1,tagger:TAGGER_VERSION,tree_hash:tree.hash,file,source_hash:digest(code),entities:entries.map(e=>e.entity),edges};
}

export function assertFresh(graph: CodeGraph, tree: KnowledgeTree, code: string): void {
  if(graph.schema!==1||graph.tagger!==TAGGER_VERSION||graph.tree_hash!==tree.hash||graph.source_hash!==digest(code))throw new Error('Stale graph: re-index changed source/knowledge/tagger before retrieval');
  const ids=new Set(graph.entities.map(e=>e.id));
  if(ids.size!==graph.entities.length||graph.edges.some(e=>!ids.has(e.from)||!ids.has(e.to)))throw new Error('Corrupt graph entity/edge');
  for(const entity of graph.entities)for(const tag of entity.tags)tree.leaf(tag.leaf);
}
export function saveGraph(path: string, graph: CodeGraph): void {
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(graph,null,2)+'\n');
}
export function loadGraph(path: string): CodeGraph {
  const graph:CodeGraph=JSON.parse(readFileSync(path,'utf8'));
  if(typeof graph.file!=='string'||isAbsolute(graph.file)||graph.file.split(/[\\/]/).includes('..')||!Array.isArray(graph.entities)||!Array.isArray(graph.edges))throw new Error('Invalid graph');
  return graph;
}
