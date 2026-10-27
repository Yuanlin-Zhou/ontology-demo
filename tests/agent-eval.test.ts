import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { extractJava, ruleCompliance, runAgentExperiment, complete, type AgentConfig } from '../eval/agent.ts';
import { verifyJava, javaTool } from '../eval/java.ts';
import { evaluateBoundaries } from '../eval/boundaries.ts';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';
import { spawnSync } from 'node:child_process';

const hasJdk = spawnSync(javaTool('javac'), ['-version']).status === 0;
describe('agent experiment correctness', () => {
  it('scores distinct violated rules and refuses empty or malformed code scores', () => {
    assert.equal(ruleCompliance(['A', 'B'], ['A', 'A', 'A']), 0.5);
    assert.equal(ruleCompliance([], []), null);
    assert.equal(ruleCompliance(['A'], [], 1), null);
    assert.equal(extractJava('```java\npublic class A {}\n```'), 'public class A {}');
    assert.throws(() => extractJava('explanation'));
    assert.throws(() => extractJava('```java\nclass A {}\n```\n```java\nclass B {}\n```'));
  });
  it('keeps usage for truncated completions and sends identical sampling settings', async t => {
    const oldKey = process.env['EVAL_API_KEY'];
    process.env['EVAL_API_KEY'] = 'test-only';
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      assert.equal(request.model, 'test-model'); assert.equal(request.temperature, 0);
      return new Response(JSON.stringify({ model: 'test-model', choices: [{ finish_reason: 'length', message: { content: 'class Broken {' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
    try {
      const response = await complete('task', { model: 'test-model', baseUrl: 'https://example.invalid', casesDir: '.', outputDir: '.' });
      assert.equal(response.code, ''); assert.equal(response.usage?.total_tokens, 15);
    } finally { if (oldKey === undefined) delete process.env['EVAL_API_KEY']; else process.env['EVAL_API_KEY'] = oldKey; t.mock.restoreAll(); }
  });
  it('distinguishes compilation success from task success', { skip: !hasJdk }, () => {
    const dir = join(REPOSITORY_ROOT, 'eval/agent-cases/AGENT-003-context');
    const contract = { source: 'ContextRunner.java', harness: join(dir, 'Harness.java'), main: 'Harness' };
    assert.equal(verifyJava(readFileSync(join(dir, 'reference.java'), 'utf8'), contract).behavior, 'passed');
    const broken = verifyJava(readFileSync(join(dir, 'before.java'), 'utf8'), contract);
    assert.equal(broken.compile, 'ok'); assert.equal(broken.behavior, 'failed');
    assert.equal(verifyJava('public class Bad { broken }').compile, 'failed');
    const notifyDir = join(REPOSITORY_ROOT, 'eval/agent-cases/AGENT-001-notify');
    const notifyContract = { source: 'NotificationService.java', harness: join(notifyDir, 'Harness.java'), main: 'Harness' };
    assert.equal(verifyJava(readFileSync(join(notifyDir, 'reference.java'), 'utf8'), notifyContract).behavior, 'passed');
    assert.equal(verifyJava(readFileSync(join(notifyDir, 'before.java'), 'utf8'), notifyContract).behavior, 'failed');
  });
  it('records failures in denominators, resumes cached responses and rejects mixed configurations', { skip: !hasJdk }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
    const config: AgentConfig = { casesDir: join(REPOSITORY_ROOT, 'eval/agent-cases'), outputDir: dir, model: 'fake', caseIds: ['AGENT-003'] };
    let calls = 0;
    const code = readFileSync(join(config.casesDir, 'AGENT-003-context/reference.java'), 'utf8');
    const fake = async () => { calls++; return { code: calls === 2 ? '' : code, raw: code, model: 'fake', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; };
    try {
      const summary = await runAgentExperiment(config, fake);
      assert.equal(calls, 3); assert.equal(summary[1]?.task_completion_rate, 0);
      assert.equal(summary[1]?.total_tokens, 15);
      const again = await runAgentExperiment(config, fake);
      assert.equal(calls, 3); assert.equal(again[1]?.generated, 0);
      await assert.rejects(runAgentExperiment({ ...config, model: 'different' }, fake), /different experiment/);
      assert.ok(existsSync(join(dir, 'repeat-1/baseline/AGENT-003/generated.java')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps independent cross-file mistakes visible in the metrics', () => {
    const report = evaluateBoundaries();
    assert.equal(report.results.filter(r => !r.correct && !r.known_limitation).length, 0);
    assert.equal(report.metrics.fp, 1); assert.equal(report.metrics.fn, 1);
    assert.equal(report.realWorld.parse_errors, 0);
  });
});
