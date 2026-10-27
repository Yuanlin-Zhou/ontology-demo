import {strict as assert} from 'node:assert';
import {it} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RuleEngine} from '../src/api/engine.ts';
import {checkJava} from '../eval/java.ts';

const javac=process.env['EVAL_JAVAC']??'javac';
const java=process.env['EVAL_JAVA']??'java';
it('checks catch/finally restoration against the real current-thread interrupt flag',
  {skip:spawnSync(javac,['-version']).status!==0&&'JDK unavailable'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'interrupt-flow-'));
    try{
      const file=join(dir,'input.java'),testSource=join(dir,'AcceptanceTest.java');
      writeFileSync(testSource,`class AcceptanceTest {
        public static void main(String[] args){
          for(boolean value:new boolean[]{false,true}){
            Thread.interrupted();new A().run(value);
            if(!Thread.currentThread().isInterrupted())throw new AssertionError("Current-thread interrupt was lost");
          }
          Thread.interrupted();
        }
      }`);
      const good=`public class A {public void run(boolean condition){
        boolean interrupted=false;
        try{throw new InterruptedException();}
        catch(InterruptedException error){interrupted=true;}
        finally{if(interrupted)Thread.currentThread().interrupt();}
      }}`;
      const examples=[
        {code:good,ok:true},
        {code:good.replace('interrupted=true;','interrupted=false;'),ok:false},
        {code:good.replace('interrupted=true;','if(condition)interrupted=true;'),ok:false},
        {code:good.replace('interrupted=true;','if(condition)interrupted=true;else interrupted=true;'),ok:true},
        {code:good.replace('Thread.currentThread().interrupt();','{Runnable later=()->Thread.currentThread().interrupt();}'),ok:false},
        {code:good.replace('Thread.currentThread().interrupt();','{Thread.currentThread().interrupt();Thread.interrupted();}'),ok:false},
      ];
      const engine=RuleEngine.load();
      for(const example of examples){
        writeFileSync(file,example.code);
        const check=checkJava(file,{javac,java,testSource,testClass:'AcceptanceTest'});
        assert.equal(check.compile.status,'ok',check.compile.detail);
        assert.equal(check.tests.status,example.ok?'ok':'failed',check.tests.detail);
        if(!example.ok)assert.match(check.tests.detail,/Current-thread interrupt was lost/);
        assert.equal(engine.validate({code:example.code,ruleIds:['TP-SHUTDOWN-003']}).violations.length,example.ok?0:1);
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  });

it('checks retry-loop flags through enclosing finally against real JVM outcomes',
  {skip:spawnSync(javac,['-version']).status!==0&&'JDK unavailable'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'interrupt-retry-loop-'));
    try {
      const file=join(dir,'input.java'),testSource=join(dir,'AcceptanceTest.java');
      writeFileSync(testSource,`class AcceptanceTest {
        public static void main(String[] args) {
          for(boolean value:new boolean[]{false,true}) {
            Thread.interrupted();new A().run(value);
            if(!Thread.currentThread().isInterrupted())throw new AssertionError("Retry loop lost interruption");
          }
          Thread.interrupted();
        }
      }`);
      const good=`public class A { public void run(boolean condition) {
        boolean interrupted=false;int attempts=0;
        try {
          while(true) {
            try { if(attempts++<2)throw new InterruptedException();break; }
            catch(InterruptedException error) { interrupted=true; }
          }
        } finally { if(interrupted)Thread.currentThread().interrupt(); }
      } }`;
      const examples=[
        {code:good,ok:true},
        {code:good.replace('while(true)', 'for(;;)'),ok:true},
        {code:good.replace('interrupted=true;', 'if(condition)interrupted=true;else interrupted=true;'),ok:true},
        {code:good.replace('interrupted=true;', 'if(condition)interrupted=true;'),ok:false},
        {code:good.replace('catch(InterruptedException error) { interrupted=true; }','catch(InterruptedException error) { interrupted=true; } interrupted=false;'),ok:false},
        {code:good.replace('} finally {', 'interrupted=false; } finally {'),ok:false},
        {code:good.replace('if(interrupted)Thread.currentThread().interrupt();','if(interrupted){Runnable later=()->Thread.currentThread().interrupt();}'),ok:false},
      ];
      const engine=RuleEngine.load();
      for(const example of examples) {
        writeFileSync(file,example.code);
        const result=checkJava(file,{javac,java,testSource,testClass:'AcceptanceTest'});
        assert.equal(result.compile.status,'ok',result.compile.detail);
        assert.equal(result.tests.status,example.ok?'ok':'failed',result.tests.detail);
        assert.equal(engine.validate({code:example.code,ruleIds:['TP-SHUTDOWN-003']}).violations.length,example.ok?0:1);
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
