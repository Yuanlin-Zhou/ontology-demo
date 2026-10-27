import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkJava } from '../eval/java.ts';
import { acceptanceTest } from '../eval/acceptance.ts';
const javac=process.env['EVAL_JAVAC']??'javac',java=process.env['EVAL_JAVA']??'java';
it('measures real expansion and idle retirement instead of trusting max/core configuration alone',
 {skip:spawnSync(javac,['-version']).status!==0&&'JDK unavailable'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'runtime-pool-growth-'));
 try {
  const file=join(dir,'input.java');
  const code=`import java.util.concurrent.*; public class Example {
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(1,2,60L,TimeUnit.SECONDS,new ArrayBlockingQueue<>(2));
  }`;
  const options={javac,java,...acceptanceTest('CASE-005')};
  writeFileSync(file,code);
  const good=checkJava(file,options);assert.equal(good.compile.status,'ok',good.compile.detail);assert.equal(good.tests.status,'ok',good.tests.detail);
  writeFileSync(file,code.replace('new ArrayBlockingQueue<>(2)','new LinkedBlockingQueue<>()'));
  const unbounded=checkJava(file,options);assert.equal(unbounded.compile.status,'ok');assert.equal(unbounded.tests.status,'failed');assert.match(unbounded.tests.detail,/bounded, testable/);
  writeFileSync(file,code.replace('1,2,60L','1,1,60L'));
  const fixed=checkJava(file,options);assert.equal(fixed.tests.status,'failed');assert.match(fixed.tests.detail,/Cannot expand/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
