/**
 * Validator registry: maps `rule.check.validator` names to deterministic
 * checkers written against the structured Java thread pool model.
 *
 * A checker returns findings; each finding becomes a `Violation`. A rule whose
 * checker returns no findings is considered satisfied — except for checkers
 * that are explicitly "presence" oriented (they report the missing construct).
 */
import type { FeatureId, Rule } from '../domain/types.ts';
import type { JavaSyntaxNode, ParsedJavaFile } from '../analyzer/java-parser.ts';
import type { JavaThreadPoolModel, PoolCreationFact } from '../analyzer/model.ts';

export interface CheckFinding {
  message: string;
  suggestion: string;
  line: number;
  column: number;
  snippet: string;
  symbol?: string;
  /** Optional supporting evidence spans (absolute positions). */
  evidence?: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; snippet: string }>;
}

export interface CheckContext {
  rule: Rule;
  params: Record<string, unknown>;
  parsed: ParsedJavaFile;
  model: JavaThreadPoolModel;
  features: ReadonlySet<FeatureId>;
  lines: string[];
  /** Source text of the analysed file. */
  code: string;
}

export type RuleCheckFn = (ctx: CheckContext) => CheckFinding[];

const REGISTRY = new Map<string, RuleCheckFn>();

export function registerValidator(name: string, check: RuleCheckFn): void {
  REGISTRY.set(name, check);
}

export function getValidator(name: string): RuleCheckFn | undefined {
  return REGISTRY.get(name);
}

export function validatorNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

/* ------------------------------------------------------------------ *
 * Helpers shared by the checkers
 * ------------------------------------------------------------------ */

export function isJavaSyntaxNode(value: unknown): value is JavaSyntaxNode {
  return value !== null && typeof value === 'object' && 'type' in value;
}

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

export function booleanParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Human readable label of a pool, used in violation messages. */
export function poolLabel(pool: PoolCreationFact): string {
  if (pool.variableName !== undefined) return `${pool.variableName} (${pool.kind})`;
  if (pool.factoryMethod !== undefined) return `Executors.${pool.factoryMethod}(...)`;
  return `${pool.kind} @L${pool.evidence.startLine}`;
}

/** Findings that reference a pool creation site. */
export function poolFinding(pool: PoolCreationFact, message: string, suggestion: string, symbol?: string): CheckFinding {
  const finding: CheckFinding = {
    message,
    suggestion,
    line: pool.evidence.startLine,
    column: pool.evidence.startColumn,
    snippet: pool.evidence.snippet,
  };
  if (symbol !== undefined) finding.symbol = symbol;
  return finding;
}

/** Pools the rules of this PoC consider "application level". */
export function applicationPools(model: JavaThreadPoolModel): PoolCreationFact[] {
  return model.pools.filter((pool) => pool.scope === 'field' || pool.scope === 'static_field' || pool.isBean);
}

export const INTEGER_MAX_VALUE = 2147483647;
