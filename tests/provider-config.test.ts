import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { chatEndpoint, completeRequest, providerParameters } from '../eval/providers/openai-compatible.ts';
import { validateExperimentConfig, type ExperimentConfig } from '../eval/experiment.ts';
const config:ExperimentConfig={model:'deepseek-v4.1-flash',command:'node',args:[],seed:42,temperature:0,maxOutputTokens:8192,maxCalls:27,timeoutMs:120000,tokenBudget:1200,topK:5,apiBase:'https://ruoli.dev/v1/chat/completions',apiKeyEnv:'TEST_RUOLI_KEY',sendSeed:false};

it('records a provider endpoint and credential selector without embedding credentials',()=>{
  validateExperimentConfig(config);
  assert.equal(chatEndpoint(config.apiBase!).href,config.apiBase);
  assert.equal(chatEndpoint('https://ruoli.dev/v1').href,config.apiBase);
  assert.throws(()=>validateExperimentConfig({...config,apiBase:'https://user:password@ruoli.dev/v1'}),/credentials/);
  assert.throws(()=>validateExperimentConfig({...config,apiBase:'https://ruoli.dev/v1?token=private'}),/credentials/);
  assert.throws(()=>validateExperimentConfig({...config,apiKeyEnv:'bad-key-name'}),/variable name/);
  assert.throws(()=>validateExperimentConfig({...config,sendSeed:'false' as unknown as boolean}),/boolean/);
  const request={model:config.model,prompt:'Java task',seed:42,temperature:0,maxOutputTokens:8192,sendSeed:false};
  assert.equal(providerParameters(new URL(config.apiBase!),request)['seed'],undefined);
  assert.equal(providerParameters(new URL(config.apiBase!),request)['thinking'],undefined);
});

it('uses only the selected runtime credential and keeps it out of normalized results',async t=>{
  const old=process.env['TEST_RUOLI_KEY'];process.env['TEST_RUOLI_KEY']='test-only-runtime-credential';
  t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
    assert.equal(url.href,config.apiBase);assert.equal((init.headers as Record<string,string>)['Authorization'],'Bearer test-only-runtime-credential');
    assert.equal(init.redirect,'error');
    const body=JSON.parse(String(init.body));assert.equal(body.model,config.model);assert.equal(body.seed,undefined);
    return new Response(JSON.stringify({model:config.model,choices:[{message:{content:'class A {}'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}));
  });
  try{
    const result=await completeRequest({model:config.model,prompt:'Java task',seed:42,temperature:0,maxOutputTokens:8192,apiBase:config.apiBase!,apiKeyEnv:'TEST_RUOLI_KEY',sendSeed:false});
    assert.equal(result.model,config.model);assert.equal(result.code,'class A {}');
    assert.equal(result.applied_parameters.endpoint,config.apiBase);assert.equal(result.applied_parameters.api_key_env,'TEST_RUOLI_KEY');
    assert.ok(!JSON.stringify(result).includes('test-only-runtime-credential'));
  }finally{if(old===undefined)delete process.env['TEST_RUOLI_KEY'];else process.env['TEST_RUOLI_KEY']=old;t.mock.restoreAll();}
});

it('does not fall back to another provider key or echo failed response bodies',async t=>{
  const request={model:config.model,prompt:'Java task',seed:42,temperature:0,maxOutputTokens:10,apiBase:config.apiBase!,apiKeyEnv:'TEST_RUOLI_MISSING_KEY'};
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('provider echoed private token',{status:403});});
  await assert.rejects(completeRequest(request),/Configure/);assert.equal(calls,0);
  const old=process.env['TEST_RUOLI_MISSING_KEY'];process.env['TEST_RUOLI_MISSING_KEY']='test-only';
  try{
    await assert.rejects(completeRequest(request),error=>error instanceof Error&&error.message.includes('HTTP 403')&&!error.message.includes('private token'));
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({model:config.model,choices:[{message:{content:'test-only'}}]})));
    await assert.rejects(completeRequest(request),/runtime credential; response omitted/);
  }
  finally{if(old===undefined)delete process.env['TEST_RUOLI_MISSING_KEY'];else process.env['TEST_RUOLI_MISSING_KEY']=old;t.mock.restoreAll();}
});
