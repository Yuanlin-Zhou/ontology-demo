/**
 * Rule Matcher (01-phase1 §7): maps semantic features to applicable atomic rules.
 *
 * Applicability semantics of `applies_when`:
 *   features       -> all must be present (AND)
 *   any_features   -> at least one must be present (OR)
 *   none_features  -> none may be present (NOT)
 */
import { PRIORITY_ORDER } from '../domain/types.ts';
import type { FeatureId, RetrievedRule, Rule } from '../domain/types.ts';
import { estimateTokens } from '../retrieval/token-estimator.ts';
import type { RuleRepository } from './rule-repository.ts';

export interface MatchOptions {
  /** Also pull in `related_rules` of matched rules (default true). */
  includeRelated?: boolean;
  /** Include `rationale` in the injected content (default false, saves tokens). */
  includeRationale?: boolean;
  /** Hard limit on the number of returned rules. */
  maxRules?: number;
  /** Soft limit on the estimated token cost of the rule payload. */
  tokenBudget?: number;
}

export interface MatchResult {
  rules: RetrievedRule[];
  /** Feature ids that did not match any rule (retrieval gaps). */
  unmatchedFeatures: FeatureId[];
  truncated: boolean;
  estimatedTokens: number;
}

/** Checks whether a rule applies to a set of detected features. */
export function isApplicable(rule: Rule, features: ReadonlySet<FeatureId>): boolean {
  const { features: required, any_features: anyOf, none_features: noneOf } = rule.applies_when;
  if (required !== undefined && !required.every((feature) => features.has(feature))) return false;
  if (anyOf !== undefined && anyOf.length > 0 && !anyOf.some((feature) => features.has(feature))) return false;
  if (noneOf !== undefined && noneOf.some((feature) => features.has(feature))) return false;
  return true;
}

function toRetrievedRule(rule: Rule, features: ReadonlySet<FeatureId>, includeRationale: boolean): RetrievedRule {
  const matched = (rule.applies_when.features ?? []).filter((feature) => features.has(feature));
  const anyMatched = (rule.applies_when.any_features ?? []).filter((feature) => features.has(feature));
  const injected = includeRationale && rule.rationale !== undefined ? `${rule.content}\n\n${rule.rationale}` : rule.content;
  const retrieved: RetrievedRule = {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    priority: rule.priority,
    description: rule.description,
    content: rule.content,
    matched_features: [...new Set([...matched, ...anyMatched])],
    via: 'applies_when',
    related_rules: rule.related_rules ?? [],
    references: rule.references ?? [],
    estimated_tokens: estimateTokens(injected),
  };
  if (rule.rationale !== undefined) retrieved.rationale = rule.rationale;
  return retrieved;
}

/** Matches the detected features against the rule repository. */
export function matchRules(repository: RuleRepository, featureIds: readonly FeatureId[], options: MatchOptions = {}): MatchResult {
  const includeRelated = options.includeRelated ?? true;
  const includeRationale = options.includeRationale ?? false;
  const features = new Set(featureIds);
  const byId = new Map<string, Rule>(repository.rules.map((rule) => [rule.id, rule]));

  const matchedRules = repository.rules.filter((rule) => isApplicable(rule, features));
  const ordered = [...matchedRules].sort(compareRules);
  const result: RetrievedRule[] = ordered.map((rule) => toRetrievedRule(rule, features, includeRationale));

  if (includeRelated) {
    const present = new Set(result.map((rule) => rule.id));
    const extras: RetrievedRule[] = [];
    for (const rule of ordered) {
      for (const relatedId of rule.related_rules ?? []) {
        if (present.has(relatedId)) continue;
        const related = byId.get(relatedId);
        if (related === undefined) continue;
        present.add(relatedId);
        const retrieved = toRetrievedRule(related, features, includeRationale);
        retrieved.via = 'related';
        retrieved.via_rule = rule.id;
        extras.push(retrieved);
      }
    }
    result.push(...extras.sort(compareRetrieved));
  }

  const unmatchedFeatures = featureIds.filter((feature) => matchedRules.every((rule) => !ruleMentions(rule, feature)));

  let truncated = false;
  let kept = result;
  if (options.maxRules !== undefined && kept.length > options.maxRules) {
    kept = kept.slice(0, options.maxRules);
    truncated = true;
  }
  if (options.tokenBudget !== undefined) {
    const budgeted: RetrievedRule[] = [];
    let used = 0;
    for (const rule of kept) {
      if (budgeted.length > 0 && used + rule.estimated_tokens > options.tokenBudget) {
        truncated = true;
        continue;
      }
      budgeted.push(rule);
      used += rule.estimated_tokens;
    }
    kept = budgeted;
  }

  return {
    rules: kept,
    unmatchedFeatures,
    truncated,
    estimatedTokens: kept.reduce((total, rule) => total + rule.estimated_tokens, 0),
  };
}

function ruleMentions(rule: Rule, feature: FeatureId): boolean {
  const { features, any_features: anyOf } = rule.applies_when;
  return (features?.includes(feature) ?? false) || (anyOf?.includes(feature) ?? false);
}

export function compareRules(a: Rule, b: Rule): number {
  const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  return priority !== 0 ? priority : a.id.localeCompare(b.id);
}

function compareRetrieved(a: RetrievedRule, b: RetrievedRule): number {
  const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  return priority !== 0 ? priority : a.id.localeCompare(b.id);
}
