/** Paired, single-turn experiment. All arms share model, sampling, tasks and contracts. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuleEngine } from '../src/api/engine.ts';
import type { RetrievalStrategy } from '../src/domain/types.ts';
import { loadCases, readCaseFile, writeJson } from './cases.ts';
import { verifyJava, type JavaContract } from './java.ts';
import { mean, markdownTable, percent } from './metrics.ts';

const SYSTEM_PROMPT = 'You are a Java coding assistant. Return exactly one complete Java source file, without explanations. Preserve the required public API. Use Java 21 and only the standard library.';

export interface AgentConfig {
  casesDir: string;
  outputDir: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  tokenBudget?: number;
  repetitions?: number;
  caseIds?: string[];
}
export interface Completion {
  code: string;
  raw: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}
export type Complete = (prompt: string, config: AgentConfig) => Promise<Completion>;
export function extractJava(content: string): string {
  const blocks = [...content.matchAll(/```(?:java)?\s*\n([\s\S]*?)```/g)];
  const code = blocks.length === 1 ? blocks[0]![1]!.trim() : content.trim();
  if (blocks.length > 1 || !/\b(class|record|interface|enum)\s+\w+/.test(code) || code.startsWith('```')) throw new Error('Response must contain exactly one complete Java source');
  return code;
}
export const complete: Complete = async (prompt, config) => {
  const key = process.env['EVAL_API_KEY'];
  const base = config.baseUrl ?? process.env['EVAL_API_BASE'];
  if (!key || !base) throw new Error('EVAL_API_BASE and EVAL_API_KEY must be configured');
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ model: config.model, temperature: config.temperature ?? 0, max_tokens: config.maxTokens ?? 4096,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }] }),
  });
  // Never persist request headers or provider error bodies (may echo credentials).
  if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
  const body = await response.json() as { model?: string; choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: Completion['usage'] };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('Empty model response');
  // Keep raw content and usage even for truncated / invalid Java, so failures cost tokens too.
  return { code: choice?.finish_reason === 'length' ? '' : (() => { try { return extractJava(content); } catch { return ''; } })(), raw: content,
    model: body.model ?? config.model, usage: body.usage ?? null };
};

export function ruleCompliance(checked: readonly string[], violated: readonly string[], parseErrors = 0): number | null {
  if (parseErrors > 0 || checked.length === 0) return null;
  const bad = new Set(violated);
  return checked.filter(id => !bad.has(id)).length / checked.length;
}
export async function runAgentExperiment(config: AgentConfig, generate: Complete = complete) {
  if (!config.model?.trim() || !config.casesDir || !config.outputDir) throw new Error('model, casesDir and outputDir are required');
  if (!Number.isFinite(config.temperature ?? 0) || (config.temperature ?? 0) < 0 || (config.temperature ?? 0) > 2) throw new Error('Invalid temperature');
  if (!Number.isInteger(config.maxTokens ?? 4096) || (config.maxTokens ?? 4096) < 1) throw new Error('Invalid maxTokens');
  if (!Number.isInteger(config.repetitions ?? 1) || (config.repetitions ?? 1) < 1) throw new Error('repetitions must be a positive integer');
  const cases = loadCases(resolve(config.casesDir), config.caseIds);
  if (config.caseIds?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown case id');
  const out = resolve(config.outputDir);
  mkdirSync(out, { recursive: true });
  const engine = RuleEngine.load();
  const manifest = { version: 1, config: { ...config, casesDir: resolve(config.casesDir), outputDir: out },
    protocol: 'single-turn; no validation feedback or repair; rotating arm order; Java 21; shared system prompt',
    system_prompt: SYSTEM_PROMPT, evaluator_sha256: hash(readFileSync(import.meta.filename, 'utf8') + readFileSync(new URL('./java.ts', import.meta.url), 'utf8')),
    engine_sha256: hash(sourceSnapshot(new URL('../src/', import.meta.url).pathname)),
    rag_corpus: ['java-thread-pool-best-practices.md', 'java-thread-pool-summary.md'].map(f => ({ file: f, sha256: hash(readFileSync(new URL('../' + f, import.meta.url), 'utf8')) })),
    rules: hash(JSON.stringify(engine.rules())), cases: cases.map(c => ({ id: c.id, task: c.task, before: hash(readCaseFile(c, 'before') ?? ''),
      contract: existsSync(join(c.dir, 'verification.json')) ? hash(readFileSync(join(c.dir, 'verification.json'), 'utf8')) : null,
      fixtures: readdirSync(c.dir).filter(f => f.endsWith('.java')).sort().map(f => ({ file: f, sha256: hash(readFileSync(join(c.dir, f), 'utf8')) })) })) };
  const manifestPath = join(out, 'manifest.json');
  if (existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') !== `${JSON.stringify(manifest, null, 2)}\n`) throw new Error('Output directory contains a different experiment; choose a new outputDir');
  writeJson(manifestPath, manifest);
  const results: Array<Record<string, unknown>> = [];
  const strategies: RetrievalStrategy[] = ['baseline', 'rag', 'rules'];
  for (let rep = 0; rep < (config.repetitions ?? 1); rep++) {
    for (let index = 0; index < cases.length; index++) {
      const c = cases[index]!;
      let contract: JavaContract | undefined;
      const contractPath = join(c.dir, 'verification.json');
      if (existsSync(contractPath)) {
        const raw = JSON.parse(readFileSync(contractPath, 'utf8')) as JavaContract;
        contract = { ...raw, ...(raw.harness ? { harness: resolve(c.dir, raw.harness) } : {}), support: raw.support?.map(f => resolve(c.dir, f)) };
      }
      // Check the fixed oracle before spending API calls; never expose it to the model.
      if (contract && existsSync(join(c.dir, 'reference.java'))) {
        const reference = verifyJava(readFileSync(join(c.dir, 'reference.java'), 'utf8'), contract);
        if (reference.behavior !== 'passed') throw new Error(`${c.id}: reference contract failed: ${reference.diagnostics}`);
      }
      const offset = (index + rep) % 3;
      for (let arm = 0; arm < 3; arm++) {
        const strategy = strategies[(arm + offset) % 3]!;
        const dir = join(out, `repeat-${rep + 1}`, strategy, c.id);
        mkdirSync(dir, { recursive: true });
        const prompt = engine.buildPrompt({ task: c.task, code: readCaseFile(c, 'before') ?? '', strategy, filePath: 'before.java', tokenBudget: config.tokenBudget ?? 1200 });
        writeFileSync(join(dir, 'prompt.md'), prompt.prompt);
        const cache = join(dir, 'completion.json');
        const started = Date.now();
        const resumed = existsSync(cache);
        let completion: Completion | undefined;
        let error: string | undefined;
        try {
          completion = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) as Completion : await generate(prompt.prompt, config);
          writeJson(cache, completion);
          if (!completion.code) throw new Error('Truncated or invalid single-file Java response');
          writeFileSync(join(dir, 'generated.java'), completion.code);
        } catch (e) { error = e instanceof Error ? e.message : 'Generation failed'; }
        const validation = !error && completion ? engine.validate({ code: completion.code }) : undefined;
        const java = !error && completion ? verifyJava(completion.code, contract) : { compile: 'unavailable', behavior: 'unavailable', diagnostics: error };
        const result = { case_id: c.id, repetition: rep + 1, strategy, requested_model: config.model, returned_model: completion?.model ?? null,
          resumed, generation: error ? 'failed' : 'ok', error: error ?? null, elapsed_ms: Date.now() - started,
          usage: completion?.usage ?? null, estimated_prompt_tokens: prompt.estimated_tokens, knowledge_tokens_estimated: prompt.context_tokens,
          violations: validation?.violations ?? [], parse_errors: validation?.stats.parse_errors ?? null,
          checked_rules: validation?.checked_rules ?? [], compliance: validation ? ruleCompliance(validation.checked_rules, validation.violations.map(v => v.rule_id), validation.stats.parse_errors) : null,
          ...java, task_completed: java.compile === 'ok' && java.behavior === 'passed' };
        writeJson(join(dir, 'result.json'), result);
        results.push(result);
        writeJson(join(out, 'results.json'), results);
        console.log(`${c.id} #${rep + 1} ${strategy}: generation=${result.generation}, compile=${result.compile}, behavior=${result.behavior}`);
      }
    }
  }
  const summaries = strategies.map(strategy => {
    const subset = results.filter(r => r['strategy'] === strategy);
    const compliance = subset.map(r => r['compliance']).filter((v): v is number => typeof v === 'number');
    const usages = subset.map(r => r['usage']).filter((v): v is NonNullable<Completion['usage']> => v !== null);
    return { strategy, attempted: subset.length, generated: subset.filter(r => r['generation'] === 'ok').length,
      compliance: compliance.length ? mean(compliance) : null, compliance_scored: compliance.length,
      violations: subset.reduce((n, r) => n + (r['violations'] as unknown[]).length, 0),
      compile_rate: subset.filter(r => r['compile'] === 'ok').length / subset.length,
      task_completion_rate: subset.filter(r => r['task_completed']).length / subset.length,
      usage_coverage: usages.length, prompt_tokens: usages.reduce((n, u) => n + u.prompt_tokens, 0), completion_tokens: usages.reduce((n, u) => n + u.completion_tokens, 0), total_tokens: usages.reduce((n, u) => n + u.total_tokens, 0) };
  });
  writeJson(join(out, 'summary.json'), summaries);
  const table = markdownTable(['Strategy', 'Attempts', 'Compliance (scored)', 'Violations', 'Compile', 'Task completion', 'Prompt tokens', 'Output tokens', 'Total tokens (coverage)'], summaries.map(s => [s.strategy, String(s.attempted), `${s.compliance === null ? 'n/a' : percent(s.compliance)} (${s.compliance_scored})`, String(s.violations), percent(s.compile_rate), percent(s.task_completion_rate), String(s.prompt_tokens), String(s.completion_tokens), `${s.total_tokens} (${s.usage_coverage}/${s.attempted})`]));
  writeFileSync(join(out, 'report.md'), `# Agent paired experiment\n\nModel: ${config.model}; temperature: ${config.temperature ?? 0}; repetitions: ${config.repetitions ?? 1}.\n\n${table}\n\nTask completion = compilation + fixed behavioral harness passed. Generation failures count as incomplete. Compliance = fraction of distinct checked rules without findings (including info); parse failures and zero applicable rules are unscored. Token costs are provider usage, not estimates; missing usage is explicitly counted. No monetary price is assumed. No repair feedback. Harnesses are not sent to the model. Small synthetic production-style tasks do not establish real-project generalization or Cline integration effectiveness.\n`);
  return summaries;
}
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function sourceSnapshot(dir: string): string { return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(f => f.isDirectory() ? sourceSnapshot(join(dir, f.name)) : f.name.endsWith('.ts') ? f.name + readFileSync(join(dir, f.name), 'utf8') : '').join(''); }
