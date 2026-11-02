/** Zero additional supplier calls. Reproduce review evidence without changing any generated Java. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkJava } from '../../../java.ts';
import { digest } from '../../../../src/knowledge/tree.ts';

const root=import.meta.dirname;
const output=process.argv[2]?resolve(process.argv[2]):join(root,'postrun-probes.json');
if(existsSync(output))throw new Error('Refusing to overwrite an existing diagnostic report');
const report=JSON.parse(readFileSync(join(root,'evidence/report.json'),'utf8'));
const results=[];
const scratch=mkdtempSync(join(tmpdir(),'tagged-postrun-'));
const client:Record<string,string>={
  'EDIT-QUEUE':'static void use(BufferedNotifier n)throws InterruptedException{n.send("x");n.stop();}',
  'EDIT-ASYNC':'static void use(EventPublisher p){p.publish("x");p.stop();}',
  'EDIT-CONTEXT':'static String use(TenantJob j)throws Exception{TenantJob.TENANT.set("caller");return j.run("tenant","x");}',
};
try{
  for(const entry of report.records) {
    const source=join(root,'evidence/results',entry.strategy,`${entry.case_id}-${entry.repetition}.java`);
    const before=readFileSync(source,'utf8');if(digest(before)!==entry.source_hash)throw new Error('Archived source changed');
    const template=readFileSync(join(root,'ClientCompileProbe.java'),'utf8').replace(
      '// Placeholder TYPE/METHOD are specialized by the diagnostic driver, never by modifying model code.',client[entry.case_id]!);
    writeFileSync(join(scratch,'ClientCompileProbe.java'),template);
    const probes=entry.case_id==='EDIT-ASYNC'?['ClientCompileProbe','LoggingProbe','InterruptProbe']:['ClientCompileProbe'];
    for(const probe of probes) {
      const result=checkJava(source,{javac:process.env['EVAL_JAVAC'],java:process.env['EVAL_JAVA'],release:21,
        testSource:probe==='ClientCompileProbe'?join(scratch,probe+'.java'):join(root,probe+'.java'),testClass:probe});
      const expected=probe==='LoggingProbe'&&entry.strategy!=='tagged'?'failed':'ok';
      results.push({strategy:entry.strategy,case_id:entry.case_id,source_hash:entry.source_hash,probe,expected,result});
      console.log(entry.strategy,entry.case_id,probe,result.compile.status,result.tests.status);
    }
    if(readFileSync(source,'utf8')!==before)throw new Error('Diagnostics modified generated source');
  }
}finally{rmSync(scratch,{recursive:true,force:true});}
writeFileSync(output,JSON.stringify({additional_model_requests:0,note:'Supplemental diagnostics; original generation and acceptance reports remain unchanged.',results},null,2)+'\n');
if(results.some(r=>r.result.compile.status!=='ok'||r.result.tests.status!==r.expected))throw new Error('Unexpected diagnostic result; see retained report');
