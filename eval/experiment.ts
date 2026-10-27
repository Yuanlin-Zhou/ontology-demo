/** Reproducible, sequential model experiment. Provider command speaks JSON on stdin/stdout. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { loadCases, readCaseFile, writeJson } from './cases.ts';
import { sha256, TASK_CRITERIA } from './acceptance.ts';
import { runEvaluation, writeReport } from './runner.ts';
import type { RetrievalStrategy } from '../src/domain/types.ts';
import type { JavaOptions } from './java.ts';
import { extractJavaSource, type ExtractedJava } from './model-output.ts';
import { deliveryContract } from './delivery-contract.ts';

export interface ExperimentConfig {
  businessContractVersion?: 1 | 2;
  model: string;
  command: string;
  args: string[];
  seed: number;
  temperature: number;
  maxOutputTokens: number;
  maxCalls: number;
  timeoutMs: number;
  tokenBudget: number;
  topK: number;
  java?: JavaOptions;
  /** Omit to run the entire dataset. */
  caseIds?: string[];
  /** Explicit subset for diagnostic retests; omitted means a three-strategy comparison. */
  strategies?: RetrievalStrategy[];
}
export function validateExperimentConfig(config: ExperimentConfig): void {
  if (!config.model?.trim() || !config.command?.trim() || !Array.isArray(config.args) || config.args.some(a => typeof a !== 'string') ||
      !Number.isSafeInteger(config.seed) || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2 ||
      ![config.maxOutputTokens, config.maxCalls, config.timeoutMs, config.tokenBudget, config.topK].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Invalid experiment config: specify model, executable/args, seed, temperature, positive limits and retrieval settings.');
  }
  if (config.businessContractVersion !== undefined && ![1,2].includes(config.businessContractVersion)) throw new Error('businessContractVersion must be 1 or 2');
  if (config.strategies !== undefined && (!Array.isArray(config.strategies) || !config.strategies.length ||
      config.strategies.some(s => !['baseline', 'rag', 'rules'].includes(s)) || new Set(config.strategies).size !== config.strategies.length)) {
    throw new Error('strategies must contain unique supported strategy names.');
  }
  if (config.caseIds !== undefined && (!Array.isArray(config.caseIds) || !config.caseIds.length ||
      config.caseIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(config.caseIds).size !== config.caseIds.length)) {
    throw new Error('caseIds must contain unique, nonempty case IDs.');
  }
}

export function runExperiment(configFile: string, outputDir: string, prepareOnly = false, resume = false): void {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as ExperimentConfig;
  validateExperimentConfig(config);
  const cases = loadCases(join(REPOSITORY_ROOT, 'cases'), config.caseIds);
  const strategies = config.strategies ?? (['baseline', 'rag', 'rules'] as const);
  if (!prepareOnly && config.maxCalls < cases.length * strategies.length) throw new Error(`maxCalls must cover all ${cases.length * strategies.length} planned generations; no partial strategy comparison.`);
  if (existsSync(outputDir) && !resume) throw new Error('Use a fresh experiment directory; existing artifacts must not be overwritten or mixed.');
  if (resume && !existsSync(join(outputDir, 'experiment.json'))) throw new Error('No experiment manifest to resume.');
  mkdirSync(outputDir, { recursive: true });
  const engine = RuleEngine.load();
  const git = (args: string[]): string => spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).stdout ?? '';
  const diff = git(['diff', '--binary', 'HEAD']);
  if (!resume) writeFileSync(join(outputDir, 'working-tree.patch'), diff);
  // Include untracked evaluation files in the provenance digest as well.
  const untracked = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
  const untrackedHashes = Object.fromEntries(untracked.map(path => [path, sha256(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'))]));
  const jobs = cases.flatMap(testCase => strategies.map(strategy => {
    const source = readCaseFile(testCase, 'before') ?? '';
    const rendered = engine.buildPrompt({ task: testCase.task, strategy, caseId: testCase.id, code: source,
      tokenBudget: config.tokenBudget, topK: config.topK });
    const prompt = rendered.prompt + deliveryContract(testCase, config.businessContractVersion ?? 1);
    const promptFile = join(outputDir, 'prompts', strategy, `${testCase.id}.md`);
    mkdirSync(dirname(promptFile), { recursive: true });
    if (!resume) writeFileSync(promptFile, prompt);
    const checklist = join(outputDir, 'review-templates', strategy, `${testCase.id}.json`);
    mkdirSync(dirname(checklist), { recursive: true });
    if (!resume) writeJson(checklist, { source_sha256: '', reviewer: '', criteria: TASK_CRITERIA[testCase.id]?.map(criterion => ({ criterion, passed: null, evidence: '' })) });
    return { case_id: testCase.id, strategy, prompt_file: promptFile, prompt_sha256: sha256(prompt),
      input_sha256: sha256(source), knowledge_tokens_estimated: rendered.context_tokens, prompt };
  }));
  const manifest = {
    protocol: 5, created_at: new Date().toISOString(), config, revision: git(['rev-parse', 'HEAD']).trim(),
    working_tree_patch_sha256: sha256(diff), untracked_sha256: untrackedHashes,
    node: process.version, planned_calls: jobs.length, prepare_only: prepareOnly,
    jobs: jobs.map(({ prompt: _prompt, ...job }) => job),
  };
  if (resume) {
    const previous = JSON.parse(readFileSync(join(outputDir, 'experiment.json'), 'utf8')) as typeof manifest;
    if (previous.prepare_only || previous.protocol !== manifest.protocol || JSON.stringify(previous.config) !== JSON.stringify(config) ||
        previous.working_tree_patch_sha256 !== manifest.working_tree_patch_sha256 ||
        JSON.stringify(previous.untracked_sha256) !== JSON.stringify(manifest.untracked_sha256) ||
        JSON.stringify(previous.jobs) !== JSON.stringify(manifest.jobs)) throw new Error('Resume refused: configuration, code or prompts changed; use a new experiment.');
    for (const job of jobs) if (sha256(readFileSync(job.prompt_file, 'utf8')) !== job.prompt_sha256) throw new Error('Resume refused: saved prompt changed.');
  } else writeJson(join(outputDir, 'experiment.json'), manifest);
  if (prepareOnly) return;
  const lock = join(outputDir, '.running.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid run lock; refusing to overwrite it.');
    let running = true;
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
    }
    if (running) throw new Error('Experiment is already running.');
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    for (const [index, job] of jobs.entries()) {
      const recordFile = join(outputDir, 'calls', job.strategy, `${job.case_id}.json`);
      if (resume && existsSync(recordFile)) {
        const call = JSON.parse(readFileSync(recordFile, 'utf8')) as { status: string; source_sha256: string | null };
        const sourceFile = join(outputDir, 'results', job.strategy, `${job.case_id}.java`);
        if (call.status === 'ok' && (!existsSync(sourceFile) || sha256(readFileSync(sourceFile, 'utf8')) !== call.source_sha256)) throw new Error('Resume refused: saved model source changed.');
        console.log(`${index + 1}/${jobs.length} ${job.strategy} ${job.case_id}: retained ${call.status}`);
        continue;
      }
      mkdirSync(dirname(recordFile), { recursive: true });
      writeJson(recordFile, { case_id: job.case_id, strategy: job.strategy, model: config.model, prompt_sha256: job.prompt_sha256, status: "started", source_sha256: null });
      const request = { model: config.model, seed: config.seed, temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens, prompt: job.prompt };
      const started = Date.now();
      const response = spawnSync(config.command, config.args, { input: JSON.stringify(request), cwd: REPOSITORY_ROOT,
        encoding: 'utf8', timeout: config.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });

      let code: string | undefined;
      const httpStatus = response.stderr?.match(/HTTP (\d{3})/)?.[1];
      let failure = response.error?.message ?? (response.status === 0 ? undefined : `Provider exited ${response.status}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
      let usage: unknown;
      let appliedParameters: unknown;
      let extraction: Omit<ExtractedJava, 'code'> | undefined;
      let rawSha256: string | undefined;
      let outputFailure = false;
      if (!failure) {
        try {
          const result = JSON.parse(response.stdout) as { model: string; code: string; usage?: unknown; applied_parameters?: unknown; raw_response?: unknown; finish_reason?: string };
          if (result.model !== config.model || typeof result.code !== 'string') throw new Error('Provider must return {model: configuredModel, code: JavaSource, usage?: ...}.');
          usage = result.usage;
          appliedParameters = result.applied_parameters;
          const rawFile = join(outputDir, 'raw-responses', job.strategy, `${job.case_id}.txt`);
          mkdirSync(dirname(rawFile), { recursive: true });
          writeFileSync(rawFile, result.code);
          rawSha256 = sha256(result.code);
          if (result.raw_response !== undefined) writeJson(rawFile.replace(/\.txt$/, '.json'), result.raw_response);
          try {
            if (result.finish_reason !== undefined && result.finish_reason !== 'stop') throw new Error(`Incomplete generation: finish_reason=${result.finish_reason}`);
            const extracted = extractJavaSource(result.code);
            code = extracted.code;
            const { code: _source, ...metadata } = extracted;
            extraction = metadata;
          } catch (error) { outputFailure = true; failure = String(error); }
        } catch (error) { failure = String(error); }
      }
      writeJson(recordFile, { case_id: job.case_id, strategy: job.strategy, model: config.model,
        prompt_sha256: job.prompt_sha256, elapsed_ms: Date.now() - started, status: failure ? (outputFailure ? 'invalid_output' : 'failed') : 'ok',
        failure, usage, applied_parameters: appliedParameters, extraction, raw_sha256: rawSha256, source_sha256: code ? sha256(code) : null });
      if (code) {
        const file = join(outputDir, 'results', job.strategy, `${job.case_id}.java`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, code);
      }
      console.log(`${index + 1}/${jobs.length} ${job.strategy} ${job.case_id}: ${failure ? 'failed' : 'ok'}`);
      // Stop on access/provider failures to avoid burning the remaining budget with unchanged requests.
      if (failure && !outputFailure) break;
    }
    const report = runEvaluation({ casesDir: join(REPOSITORY_ROOT, 'cases'), outputDir,
      tokenBudget: config.tokenBudget, topK: config.topK, strategies, evaluateAgentResults: true, businessContractVersion: config.businessContractVersion ?? 1,
      ...(config.caseIds ? { caseIds: config.caseIds } : {}),
      ...(config.java ? { java: config.java } : {}) });
    writeReport(report, outputDir);
    if (report.agent.some(item => item.output !== 'present')) throw new Error('Experiment incomplete; see call records and per-case report. Do not claim a completed strategy comparison.');
  } finally { unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [config, output, flag] = process.argv.slice(2);
  if (!config || !output || (flag !== undefined && flag !== '--prepare' && flag !== '--resume')) {
    throw new Error('Usage: node eval/experiment.ts CONFIG.json OUTPUT_DIR [--prepare|--resume]');
  }
  runExperiment(resolve(config), resolve(output), flag === '--prepare', flag === '--resume');
}
