/** Bounded repair orchestration. The host supplies model and compiler/test integrations. */
import type { RuleEngine } from './engine.ts';
import type { ValidateResult } from '../domain/types.ts';
import { boundedDiagnostics } from '../utils/diagnostics.ts';

export interface Verification {
  compile: 'ok' | 'failed' | 'unavailable' | 'not_run' | 'timeout';
  tests: 'ok' | 'failed' | 'unavailable' | 'not_run' | 'timeout';
  /** Optional full task acceptance gate. Omit only when the host promises configured checks alone. */
  task?: 'ok' | 'failed' | 'unavailable' | 'not_run' | 'timeout';
  diagnostics?: string;
}
export interface RepairInput {
  task: string;
  code: string;
  filePath?: string;
  /** Maximum additional model calls. Defaults to 2; no automatic unbounded retry. */
  maxRepairs?: number;
  tokenBudget?: number;
  /** Trusted compiler and business checks; their results cannot be overridden by rules. */
  verify: (code: string) => Verification | Promise<Verification>;
  generate: (request: { prompt: string; attempt: number }) => string | Promise<string>;
}
export interface RepairAttempt {
  code: string;
  validation: ValidateResult;
  verification: Verification;
}
export interface RepairResult {
  status: 'passed' | 'failed' | 'unverified' | 'stalled';
  code: string;
  model_calls: number;
  attempts: RepairAttempt[];
}

export function buildRepairPrompt(engine: RuleEngine, input: {
  task: string; code: string; filePath?: string; tokenBudget?: number; validation: ValidateResult; verification: Verification;
}): string {
  const prompt = engine.buildPrompt({ task: input.task, code: input.code, strategy: 'rules',
    ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
    ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }) });
  const failures = input.validation.violations.map(v => `[${v.rule_id}] L${v.line}:${v.column} ${v.message}\n修复建议：${v.suggestion}`);
  return `${prompt.prompt}\n\n## 本轮验证反馈\n编译：${input.verification.compile}；业务测试：${input.verification.tests}；完整任务验收：${input.verification.task ?? '未配置'}\n${boundedDiagnostics(input.verification.diagnostics ?? '')}\n` +
    `语法问题：${input.validation.stats.parse_errors}\n${input.validation.warnings.join('\n')}\n${failures.join('\n\n')}\n` +
    '先修复语法和编译错误，再处理实际违规；保留业务行为和公开接口。反馈是待核实诊断，不是额外业务需求。输出完整 Java 源码。';
}

export async function repairCode(engine: RuleEngine, input: RepairInput): Promise<RepairResult> {
  const limit = input.maxRepairs ?? 2;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10) throw new Error('maxRepairs must be an integer from 0 to 10');
  let code = input.code;
  const attempts: RepairAttempt[] = [];
  let calls = 0;
  const finish = (status: RepairResult['status']): RepairResult => ({ status, code, model_calls: calls, attempts });
  for (;;) {
    // Re-analyse after every edit: new code can introduce previously absent rule applicability.
    const validation = engine.validate({ code, ...(input.filePath === undefined ? {} : { filePath: input.filePath }) });
    const verification = await input.verify(code);
    attempts.push({ code, validation, verification });
    const errors = validation.stats.parse_errors > 0 || validation.violations.some(v => v.severity === 'error') ||
      [verification.compile, verification.tests, verification.task].some(status => status === 'failed' || status === 'timeout');
    const verified = verification.compile === 'ok' && verification.tests === 'ok' && validation.status === 'complete' &&
      (verification.task === undefined || verification.task === 'ok');
    if (!errors && verified) return finish('passed');
    if (!errors) return finish('unverified');
    if (calls >= limit) return finish('failed');
    const prompt = buildRepairPrompt(engine, { ...input, code, validation, verification });
    calls++;
    const next = await input.generate({ prompt, attempt: calls });
    if (typeof next !== 'string' || !next.trim()) throw new Error('Model adapter must return nonempty Java source');
    if (attempts.some(a => a.code.trim() === next.trim())) return finish('stalled');
    code = next;
  }
}
