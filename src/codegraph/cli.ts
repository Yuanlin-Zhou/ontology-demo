/** Lightweight JSON CodeGraph: index / inspect / retrieve. No model calls. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../api/engine.ts';
import { KnowledgeTree, digest } from '../knowledge/tree.ts';
import { buildGraph, loadGraph, saveGraph, type ManualTag } from './graph.ts';
import { retrieveByTags, type PlannedKnowledge } from '../tag-retrieval/retrieve.ts';

export function graphCli(argv:string[]):void {
  const [command,...rest]=argv;
  const value=(name:string)=>rest[rest.indexOf(name)+1];
  const required=(name:string)=>{if(!rest.includes(name)||!value(name))throw new Error(`Missing ${name}`);return value(name)!;};
  const engine=RuleEngine.load();const tree=KnowledgeTree.load(REPOSITORY_ROOT,engine.rules());
  if(command==='tree'){process.stdout.write(JSON.stringify({hash:tree.hash,nodes:tree.nodes},null,2)+'\n');return;}
  const graphPath=resolve(required('--graph'));
  if(command==='inspect'){process.stdout.write(JSON.stringify(loadGraph(graphPath),null,2)+'\n');return;}
  if(command==='index') {
    const file=relative(REPOSITORY_ROOT,resolve(required('--file'))).replaceAll('\\','/');
    const code=readFileSync(resolve(REPOSITORY_ROOT,file),'utf8');
    let manual:ManualTag[]=[];
    if(existsSync(graphPath)) {
      const old=loadGraph(graphPath);
      if(old.file!==file)throw new Error('Graph path belongs to another file');
      manual=old.entities.flatMap(e=>e.tags.filter(t=>t.origin==='manual').map(t=>({entity:e.id,leaf:t.leaf,reason:t.evidence})));
      if(manual.length&&(old.source_hash!==digest(code)||old.tree_hash!==tree.hash)&&!rest.includes('--manual'))throw new Error('Manual tags require re-review after source/knowledge changes; provide --manual with approved bindings');
    }
    if(rest.includes('--manual'))manual=JSON.parse(readFileSync(resolve(required('--manual')),'utf8'));
    // Build first: invalid Java or deleted manually-tagged entities cannot corrupt a prior graph.
    saveGraph(graphPath,buildGraph(engine,tree,file,code,manual));
    process.stdout.write(`Indexed ${file} -> ${graphPath}\n`);return;
  }
  if(command==='retrieve') {
    const graph=loadGraph(graphPath);
    const code=readFileSync(resolve(REPOSITORY_ROOT,graph.file),'utf8');
    const planned:PlannedKnowledge[]=rest.includes('--planned')?JSON.parse(readFileSync(resolve(required('--planned')),'utf8')):[];
    const result=retrieveByTags(tree,graph,code,{entities:[required('--entity')],planned,
      tokenBudget:rest.includes('--budget')?Number(required('--budget')):1200});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');return;
  }
  throw new Error('Usage: node src/codegraph/cli.ts tree | index --file FILE --graph JSON [--manual JSON] | inspect --graph JSON | retrieve --graph JSON --entity ID [--planned JSON] [--budget 1200]');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)graphCli(process.argv.slice(2));
