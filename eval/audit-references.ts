/** Read-only local audit of reference examples. Passing probes never imply complete business acceptance. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,delimiter,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {RuleEngine,REPOSITORY_ROOT} from '../src/api/engine.ts';
import {loadCases} from './cases.ts';
import {acceptanceTest,TASK_CRITERIA,sha256} from './acceptance.ts';
import {checkJava,type JavaOptions} from './java.ts';
import {parseJava} from '../src/analyzer/java-parser.ts';
import {walk,childForField} from '../src/analyzer/ast-utils.ts';
import {ACCEPTANCE_COVERAGE} from './acceptance-coverage.ts';

export function auditReferences(outputDir:string,java:JavaOptions={}):void {
  if(existsSync(outputDir))throw new Error('Use a fresh audit directory; never overwrite evidence.');
  const auditSourceSha=sha256(readFileSync(new URL(import.meta.url),'utf8'));
  const cases=loadCases(join(REPOSITORY_ROOT,'cases'));
  for(const c of cases)if(!TASK_CRITERIA[c.id]||!ACCEPTANCE_COVERAGE[c.id])throw new Error('Missing acceptance coverage: '+c.id);
  mkdirSync(outputDir,{recursive:true});mkdirSync(join(outputDir,'sources'));
  const engine=RuleEngine.load();
  const records=cases.map(c=>{
    // CASE-019 deliberately uses unchanged, nonconcurrent before.java as its negative-control reference.
    const file=c.files.good??(c.id==='CASE-019'?c.files.before:undefined);
    const role=c.files.good?'good':'negative_control_before';
    if(!file)throw new Error('Reference source missing: '+c.id);
    const code=readFileSync(file,'utf8');
    const emptyMethods:Array<{method:string;line:number}>=[];
    walk(parseJava(code).rootNode,n=>{
      if(n.type!=='method_declaration')return;
      const body=childForField(n,'body');
      if(body&&!body.namedChildren.some(child=>!['line_comment','block_comment'].includes(child.type)))
        emptyMethods.push({method:childForField(n,'name')?.text??'',line:n.startPosition.row+1});
    });
    const adapter=acceptanceTest(c.id);
    const checks=checkJava(file,{...java,...adapter});
    const validation=engine.validate({code});
    const record={case_id:c.id,title:c.title,file,role,source_sha256:sha256(code),
      acceptance_file:adapter?.testSource,acceptance_sha256:adapter?sha256(readFileSync(adapter.testSource,'utf8')):undefined,
      ...checks,validation,empty_methods:emptyMethods,criteria:TASK_CRITERIA[c.id],coverage:ACCEPTANCE_COVERAGE[c.id]!,
      task_status:'not_reviewed' as const};
    writeFileSync(join(outputDir,'sources',c.id+'.java'),code);
    writeFileSync(join(outputDir,c.id+'.json'),JSON.stringify(record,null,2)+'\n');
    console.log(`${c.id}: compile=${checks.compile.status}, runtime=${checks.tests.status}, errors=${validation.violations.filter(v=>v.severity==='error').length}, empty_methods=${emptyMethods.length}`);
    return record;
  });
  const summary={kind:'reference-audit-not-model-evaluation',created_at:new Date().toISOString(),java,
    audit_source_sha256:auditSourceSha,
    model_calls:0,total:records.length,compile_passed:records.filter(r=>r.compile.status==='ok').length,
    runtime_probe_passed:records.filter(r=>r.tests.status==='ok').length,
    records_with_empty_methods:records.filter(r=>r.empty_methods.length).length,
    criteria_source_sha256:sha256(readFileSync(join(REPOSITORY_ROOT,'eval/acceptance.ts'),'utf8')),
    coverage_source_sha256:sha256(readFileSync(join(REPOSITORY_ROOT,'eval/acceptance-coverage.ts'),'utf8')),
    records};
  writeFileSync(join(outputDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const cell=(s:string)=>s.replaceAll('|','\\|').replaceAll('\n',' ');
  const lines=['# 21 用例参考实现验收矩阵','',
    `编译通过 ${summary.compile_passed}/${records.length}；当前运行探针通过 ${summary.runtime_probe_passed}/${records.length}；含空方法的参考源码 ${summary.records_with_empty_methods} 份。`,
    '', '这里的通过仅指当前探针，不是完整任务通过；该工具不执行任务审查，task_status 保持 not_reviewed，不覆盖另存的源码绑定审查。CASE-019 使用 before.java 负对照。每例 JSON 和 sources/ 副本绑定实际源码与验收器哈希，空方法只是审查线索。',
    '', '| 用例 | 编译 | 静态 error | 运行探针 | 空方法 | 正常路径覆盖 | 异常路径覆盖 | 关闭覆盖 | 仍需补齐 |',
    '| --- | --- | ---: | --- | --- | --- | --- | --- | --- |'];
  for(const r of records)lines.push('| '+[r.case_id,r.compile.status,String(r.validation.violations.filter(v=>v.severity==='error').length),r.tests.status,
    r.empty_methods.map(m=>m.method).join(', ')||'无',r.coverage.normal,r.coverage.failure,r.coverage.lifecycle,r.coverage.priority+'：'+r.coverage.gaps].map(cell).join(' | ')+' |');
  lines.push('','## 每项原始验收标准','');
  for(const r of records)lines.push(`- ${r.case_id}：${r.criteria?.join('；')}。源码：${relative(outputDir,r.file)}`);
  writeFileSync(join(outputDir,'report.md'),lines.join('\n')+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [out,configFile]=process.argv.slice(2);if(!out)throw new Error('Usage: node eval/audit-references.ts OUT_DIR [JAVA_CONFIG_JSON]');
  let java:JavaOptions={...(process.env['EVAL_JAVAC']?{javac:process.env['EVAL_JAVAC']} :{}),
    ...(process.env['EVAL_JAVA']?{java:process.env['EVAL_JAVA']} :{}),
    ...(process.env['EVAL_CLASSPATH']?{classpath:process.env['EVAL_CLASSPATH'].split(delimiter)}:{})};
  if(configFile){const config=JSON.parse(readFileSync(configFile,'utf8'));java=config.java??config;}
  auditReferences(resolve(out),java);
}
