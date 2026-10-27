/**
 * Loads atomic rules from `knowledge/<language>/<domain>/*.yaml`, validates them
 * and indexes them by id (01-phase1 §4).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FEATURE_IDS } from '../domain/features.ts';
import type { Priority, Rule, RuleApplicability, RuleCheck, RuleExample, Severity } from '../domain/types.ts';

export class RuleValidationError extends Error {
  override name = 'RuleValidationError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`knowledge base is invalid:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const SEVERITIES: readonly string[] = ['error', 'warning', 'info'];
const PRIORITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];
const FEATURE_ID_PATTERN = /^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)+$/;

export interface RuleRepositoryOptions {
  /** Directory holding `<language>/<domain>/*.yaml` files. */
  knowledgeDir: string;
  /** When true (default) unknown feature ids are rejected instead of warned. */
  strictFeatures?: boolean;
}

export class RuleRepository {
  readonly rules: Rule[];
  readonly knowledgeDir: string;
  readonly warnings: string[];
  private readonly byId: Map<string, Rule>;

  private constructor(rules: Rule[], knowledgeDir: string, warnings: string[]) {
    this.rules = rules;
    this.knowledgeDir = knowledgeDir;
    this.warnings = warnings;
    this.byId = new Map(rules.map((rule) => [rule.id, rule]));
  }

  /** Loads and validates every YAML file below `knowledgeDir` (skipping `schema/`). */
  static load(options: RuleRepositoryOptions): RuleRepository {
    const problems: string[] = [];
    const warnings: string[] = [];
    const rules: Rule[] = [];
    const strictFeatures = options.strictFeatures ?? true;

    const files = listYamlFiles(options.knowledgeDir);
    if (!files.length) throw new RuleValidationError([`No YAML rules found in ${options.knowledgeDir}`]);
    for (const file of files) {
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(file, 'utf8'));
      } catch (cause) {
        problems.push(`${rel(options.knowledgeDir, file)}: YAML 解析失败: ${(cause as Error).message}`);
        continue;
      }
      const entries = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
      if (entries.length === 0) warnings.push(`${rel(options.knowledgeDir, file)}: 文件里没有规则`);
      for (const entry of entries) {
        const rule = normalizeRule(entry, file, options.knowledgeDir, problems, warnings, strictFeatures);
        if (rule !== null) rules.push(rule);
      }
    }

    const seen = new Map<string, string>();
    for (const rule of rules) {
      const previous = seen.get(rule.id);
      if (previous !== undefined) problems.push(`规则 id 重复: ${rule.id} (${previous} / ${rule.source ?? ''})`);
      else seen.set(rule.id, rule.source ?? '');
    }
    for (const rule of rules) {
      for (const related of rule.related_rules ?? []) {
        if (!seen.has(related)) problems.push(`${rule.id}: related_rules 引用了不存在的规则 ${related}`);
      }
    }
    if (problems.length > 0) throw new RuleValidationError(problems);
    return new RuleRepository(
      rules.sort((a, b) => a.id.localeCompare(b.id)),
      options.knowledgeDir,
      warnings,
    );
  }

  get(id: string): Rule | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return this.rules.map((rule) => rule.id);
  }

  byIds(ids: readonly string[]): Rule[] {
    const wanted = new Set(ids);
    return this.rules.filter((rule) => wanted.has(rule.id));
  }

  byDomain(language?: string, domain?: string): Rule[] {
    return this.rules.filter((rule) => {
      if (language !== undefined && rule.language !== language) return false;
      if (domain !== undefined && !rule.domain.includes(domain)) return false;
      return true;
    });
  }

  /** Rules that declare a deterministic checker (i.e. can produce violations). */
  checkable(): Rule[] {
    return this.rules.filter((rule) => rule.check !== undefined);
  }
}

function listYamlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new RuleValidationError([`Cannot read knowledge directory ${dir}: ${(error as Error).message}`]);
  }
  for (const entry of entries) {
    if (entry === 'schema' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listYamlFiles(full));
    else if (/\.ya?ml$/i.test(entry)) out.push(full);
  }
  return out.sort();
}

function rel(base: string, file: string): string {
  return relative(base, file).replace(/\\/g, '/');
}
function normalizeRule(
  entry: unknown,
  file: string,
  knowledgeDir: string,
  problems: string[],
  warnings: string[],
  strictFeatures: boolean,
): Rule | null {
  const source = rel(knowledgeDir, file);
  if (entry === null || typeof entry !== 'object') {
    problems.push(`${source}: 规则条目不是对象`);
    return null;
  }
  const raw = entry as Record<string, unknown>;
  const id = asString(raw['id']);
  if (id === undefined) {
    problems.push(`${source}: 缺少 id`);
    return null;
  }
  const where = `${source}#${id}`;
  const name = asString(raw['name']);
  const description = asString(raw['description']);
  const content = asString(raw['content']);
  if (name === undefined) problems.push(`${where}: 缺少 name`);
  if (description === undefined) problems.push(`${where}: 缺少 description`);
  if (content === undefined) problems.push(`${where}: 缺少 content（注入 Agent 的规则正文）`);

  const language = asString(raw['language']) ?? 'java';
  const domain = asStringArray(raw['domain']);
  if (domain.length === 0) problems.push(`${where}: 缺少 domain`);

  const appliesWhen = normalizeApplicability(raw['applies_when'], where, problems, warnings, strictFeatures);
  const severity = asSeverity(asString(raw['severity']), where, problems);
  const priority = asPriority(asString(raw['priority']), where, problems);
  const check = normalizeCheck(raw['check'], where, problems);
  const examples = normalizeExamples(raw['examples'], where, problems);
  const rationale = asString(raw['rationale']);

  if (name === undefined || description === undefined || content === undefined) return null;

  const rule: Rule = {
    id,
    name,
    domain: domain.length > 0 ? domain : [language, 'concurrency', 'thread_pool'],
    language,
    applies_when: appliesWhen,
    description,
    content: content.trim(),
    severity,
    priority,
    related_rules: asStringArray(raw['related_rules']),
    references: asStringArray(raw['references']),
    tags: asStringArray(raw['tags']),
    source: file.replace(/\\/g, '/'),
  };
  if (rationale !== undefined) rule.rationale = rationale;
  if (check !== undefined) rule.check = check;
  if (examples !== undefined) rule.examples = examples;
  return rule;
}

function normalizeApplicability(
  value: unknown,
  where: string,
  problems: string[],
  warnings: string[],
  strictFeatures: boolean,
): RuleApplicability {
  const raw = value === null || typeof value !== 'object' || Array.isArray(value) ? {} : (value as Record<string, unknown>);
  for (const key of Object.keys(raw)) {
    if (!['features', 'any_features', 'none_features'].includes(key)) problems.push(`${where}: unknown applies_when key ${key}`);
    const field = raw[key];
    if (!Array.isArray(field) || field.some(f => typeof f !== 'string' || !f.trim())) problems.push(`${where}: applies_when.${key} must be an array of feature IDs`);
  }
  const features = asStringArray(raw['features']);
  const anyFeatures = asStringArray(raw['any_features']);
  const noneFeatures = asStringArray(raw['none_features']);
  if (features.length === 0 && anyFeatures.length === 0 && noneFeatures.length === 0) {
    problems.push(`${where}: applies_when 至少要定义 features / any_features / none_features 之一`);
  }
  const known = new Set(FEATURE_IDS);
  for (const feature of [...features, ...anyFeatures, ...noneFeatures]) {
    if (!FEATURE_ID_PATTERN.test(feature)) problems.push(`${where}: 特征 id 格式非法: ${feature}`);
    else if (!known.has(feature)) {
      const message = `${where}: 特征 ${feature} 不在特征目录中 (src/domain/features.ts)`;
      if (strictFeatures) problems.push(message);
      else warnings.push(message);
    }
  }
  const applicability: RuleApplicability = {};
  if (features.length > 0) applicability.features = features;
  if (anyFeatures.length > 0) applicability.any_features = anyFeatures;
  if (noneFeatures.length > 0) applicability.none_features = noneFeatures;
  return applicability;
}

function normalizeCheck(value: unknown, where: string, problems: string[]): RuleCheck | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') {
    problems.push(`${where}: check 必须是对象`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const validator = asString(raw['validator']);
  if (validator === undefined) {
    problems.push(`${where}: check.validator 缺失`);
    return undefined;
  }
  const params = raw['params'];
  return params !== null && typeof params === 'object' ? { validator, params: params as Record<string, unknown> } : { validator };
}
function normalizeExamples(value: unknown, where: string, problems: string[]): Rule['examples'] {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') {
    problems.push(`${where}: examples 必须是对象`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const positive = asExamples(raw['positive'], where, problems);
  const negative = asExamples(raw['negative'], where, problems);
  const examples: NonNullable<Rule['examples']> = {};
  if (positive.length > 0) examples.positive = positive;
  if (negative.length > 0) examples.negative = negative;
  return examples;
}

function asExamples(value: unknown, where: string, problems: string[]): RuleExample[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: RuleExample[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      problems.push(`${where}: examples 条目必须是对象`);
      continue;
    }
    const raw = item as Record<string, unknown>;
    const code = asString(raw['code']);
    if (code === undefined) {
      problems.push(`${where}: examples 条目缺少 code`);
      continue;
    }
    const note = asString(raw['note']);
    out.push(note === undefined ? { code } : { code, note });
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function asSeverity(value: string | undefined, where: string, problems: string[]): Severity {
  if (value === undefined) return 'warning';
  if (!SEVERITIES.includes(value)) {
    problems.push(`${where}: severity 非法: ${value}`);
    return 'warning';
  }
  return value as Severity;
}

function asPriority(value: string | undefined, where: string, problems: string[]): Priority {
  if (value === undefined) return 'medium';
  if (!PRIORITIES.includes(value)) {
    problems.push(`${where}: priority 非法: ${value}`);
    return 'medium';
  }
  return value as Priority;
}
