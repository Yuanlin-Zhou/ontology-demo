/**
 * Case loader for the Phase 1 evaluation dataset.
 *
 * Dataset layout:
 *   cases/CASE-xxx/case.yaml     task, expectations
 *   cases/CASE-xxx/before.java   (optional) current code -> retrieve() input
 *   cases/CASE-xxx/bad.java      (optional) violating implementation -> validate()
 *   cases/CASE-xxx/good.java     (optional) compliant implementation -> validate()
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface CaseViolationExpectation {
  rule_id: string;
  /** Optional: expected line of the violation (informational). */
  line?: number;
}

export interface EvaluationCase {
  id: string;
  title: string;
  task: string;
  language: string;
  domain: string;
  dir: string;
  files: {
    before?: string;
    bad?: string;
    good?: string;
  };
  expected: {
    features: string[];
    rules: string[];
    optional_rules: string[];
    violations: string[];
    compliant_violations: string[];
  };
  notes?: string[];
}

export class CaseValidationError extends Error {
  override name = 'CaseValidationError';
}

export function loadCases(casesDir: string, filter?: readonly string[]): EvaluationCase[] {
  const problems: string[] = [];
  const cases: EvaluationCase[] = [];
  let entries: string[];
  try {
    entries = readdirSync(casesDir);
  } catch {
    throw new CaseValidationError(`cases 目录不存在: ${casesDir}`);
  }
  for (const entry of entries) {
    const dir = join(casesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = join(dir, 'case.yaml');
    if (!existsSync(manifest)) continue;
    const raw = parseYaml(readFileSync(manifest, 'utf8')) as Record<string, unknown> | null;
    if (raw === null) {
      problems.push(`${entry}: case.yaml 为空`);
      continue;
    }
    const testCase = normalizeCase(raw, dir, entry, problems);
    if (testCase === null) continue;
    if (filter !== undefined && filter.length > 0 && !filter.includes(testCase.id)) continue;
    cases.push(testCase);
  }
  if (problems.length > 0) throw new CaseValidationError(`用例定义有误:\n- ${problems.join('\n- ')}`);
  const unknown = filter?.filter(id => !cases.some(testCase => testCase.id === id)) ?? [];
  if (unknown.length) throw new CaseValidationError(`未知的用例: ${unknown.join(', ')}`);
  if (cases.length === 0) throw new CaseValidationError(`没有找到任何用例: ${casesDir}`);
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** Reads a case file, resolving the optional file names from case.yaml. */
export function readCaseFile(testCase: EvaluationCase, which: 'before' | 'bad' | 'good'): string | undefined {
  const file = testCase.files[which];
  if (file === undefined) return undefined;
  return readFileSync(file, 'utf8');
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeCase(
  raw: Record<string, unknown>,
  dir: string,
  dirName: string,
  problems: string[],
): EvaluationCase | null {
  const id = asString(raw['id']) ?? dirName;
  const task = asString(raw['task']);
  if (task === undefined) {
    problems.push(`${dirName}: 缺少 task`);
    return null;
  }
  const filesRaw = raw['files'] === null || typeof raw['files'] !== 'object' ? {} : (raw['files'] as Record<string, unknown>);
  const files: EvaluationCase['files'] = {};
  for (const which of ['before', 'bad', 'good'] as const) {
    const name = asString(filesRaw[which]);
    const candidate = name ?? `${which}.java`;
    const full = join(dir, candidate);
    if (existsSync(full)) files[which] = full;
    else if (name !== undefined) problems.push(`${dirName}: files.${which} 指向的文件不存在: ${candidate}`);
  }
  const expectedRaw = raw['expected'] === null || typeof raw['expected'] !== 'object' ? {} : (raw['expected'] as Record<string, unknown>);
  const expected = {
    features: asStringArray(expectedRaw['features']),
    rules: asStringArray(expectedRaw['rules']),
    optional_rules: asStringArray(expectedRaw['optional_rules']),
    violations: asStringArray(expectedRaw['violations']),
    compliant_violations: asStringArray(expectedRaw['compliant_violations']),
  };
  if (files.before === undefined && files.bad === undefined && files.good === undefined) {
    problems.push(`${dirName}: 至少需要 before.java / bad.java / good.java 之一`);
    return null;
  }
  const testCase: EvaluationCase = {
    id,
    title: asString(raw['title']) ?? id,
    task,
    language: asString(raw['language']) ?? 'java',
    domain: asString(raw['domain']) ?? 'thread_pool',
    dir,
    files,
    expected,
  };
  const notes = asStringArray(raw['notes']);
  if (notes.length > 0) testCase.notes = notes;
  return testCase;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return [];
}
