/** Evaluate explicitly imported edit outputs; does not make model calls or claim provider provenance. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../../src/api/engine.ts';
import { KnowledgeTree, digest } from '../../src/knowledge/tree.ts';
import { checkJava } from '../java.ts';
import { ruleCompliance } from '../metrics.ts';
import { prepareEdits } from './prepare.ts';

type Manifest=ReturnType<typeof prepareEdits>;
export function evaluateEdits(directory:string,output:string) {
  if(existsSync(output))throw new Error('Use a fresh report path');
  const manifest:Manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  if(manifest.protocol!=='entity-tag-edit-v1'||manifest.model_requests!==0||!manifest.prepare_only)throw new Error('Unsupported edit manifest');
  const engine=RuleEngine.load();const tree=KnowledgeTree.load(REPOSITORY_ROOT,engine.rules());
  if(tree.hash!==manifest.tree_hash||digest(readFileSync(join(directory,'AcceptanceTest.java'),'utf8'))!==manifest.acceptance_hash||
    digest(readFileSync(join(directory,'suite.json'),'utf8'))!==manifest.suite_hash)throw new Error('Frozen inputs/knowledge changed');
  const records=manifest.jobs.map(job=>{
    if(digest(readFileSync(join(directory,'inputs',job.case_id+'.java'),'utf8'))!==job.source_hash||
      digest(readFileSync(join(directory,job.prompt_file),'utf8'))!==job.prompt_hash)throw new Error('Input/prompt changed');
    const file=join(directory,'results',job.strategy,`${job.case_id}-${job.repetition}.java`);
    if(!existsSync(file))return {case_id:job.case_id,strategy:job.strategy,repetition:job.repetition,output:'missing',compile:'not_run',behavior:'not_run',task:'not_assessed',usage:null};
    const code=readFileSync(file,'utf8');const validation=engine.validate({code,filePath:file});
    const checked=validation.checked_rules.filter(id=>engine.rule(id)?.severity!=='info');
    const violated=validation.violations.filter(v=>v.severity!=='info').map(v=>v.rule_id);
    const java=checkJava(file,{javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],release:21,
      testSource:join(directory,'AcceptanceTest.java'),testClass:'AcceptanceTest',testArgs:[job.case_id]});
    return {case_id:job.case_id,strategy:job.strategy,repetition:job.repetition,output:'present',source_hash:digest(code),
      validation,compliance:validation.status==='complete'?ruleCompliance(checked,violated):null,
      compile:java.compile.status,behavior:java.tests.status,java,
      task:[java.compile.status,java.tests.status].some(s=>s==='failed'||s==='timeout')?'failed':'review_required',usage:null};
  });
  const report={protocol:manifest.protocol,model_requests:0,controlled_model_comparison:false,
    provenance:'Imported outputs: no authenticated provider call records or measured usage; do not rank model quality/cost from this report.',
    planned:manifest.jobs.length,present:records.filter(r=>r.output==='present').length,records};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [directory,output]=process.argv.slice(2);if(!directory||!output)throw new Error('Usage: node eval/tagged-edit/evaluate.ts PREPARED_DIR NEW_REPORT.json');
  const report=evaluateEdits(resolve(directory),resolve(output));console.log(`Evaluated ${report.present}/${report.planned} imported edit outputs; provider usage unknown.`);
}
