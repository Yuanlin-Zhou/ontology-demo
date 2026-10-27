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
import { ruleContext, renderRule, nonNegativeLimit } from '../retrieval/knowledge-payload.ts';
import { estimateTokens } from '../retrieval/token-estimator.ts';
import type { RuleRepository } from './rule-repository.ts';

export interface MatchOptions {
  /** Include one-hop conditional advice (default false); exclusions still apply. */
  includeRelated?: boolean;
  /** Findings in the current code take precedence over already satisfied guidance. */
  violatedRuleIds?: readonly string[];
  /** Include `rationale` in the injected content (default false, saves tokens). */
  includeRationale?: boolean;
  /** Hard limit on the number of returned rules. */
  maxRules?: number;
  /** Hard limit on the estimated token cost of the rule payload. */
  tokenBudget?: number;
}

export interface MatchResult {
  rules: RetrievedRule[];
  /** Feature ids that did not match any rule (retrieval gaps). */
  unmatchedFeatures: FeatureId[];
  truncated: boolean;
  droppedRuleIds: string[];
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

export function toRetrievedRule(rule: Rule, features: ReadonlySet<FeatureId>, includeRationale: boolean): RetrievedRule {
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
  if (includeRationale && rule.rationale !== undefined) retrieved.rationale = rule.rationale;
  retrieved.estimated_tokens = estimateTokens(renderRule(retrieved));
  return retrieved;
}

/** Matches the detected features against the rule repository. */
export function matchRules(repository: RuleRepository, featureIds: readonly FeatureId[], options: MatchOptions = {}): MatchResult {
  nonNegativeLimit(options.tokenBudget, 'tokenBudget');
  nonNegativeLimit(options.maxRules, 'maxRules');
  const includeRelated = options.includeRelated ?? false;
  const includeRationale = options.includeRationale ?? false;
  const features = new Set(featureIds);
  const byId = new Map<string, Rule>(repository.rules.map((rule) => [rule.id, rule]));

  const matchedRules = repository.rules.filter((rule) => isApplicable(rule, features));
  const violated = new Set(options.violatedRuleIds ?? []);
  const ordered = [...matchedRules].sort((a,b) => Number(violated.has(b.id)) - Number(violated.has(a.id)) ||
    (violated.has(a.id) ? ({error:0,warning:1,info:2}[a.severity] - {error:0,warning:1,info:2}[b.severity]) : 0) || compareRules(a,b));
  const result: RetrievedRule[] = ordered.map((rule) => toRetrievedRule(rule, features, includeRationale));

  if (includeRelated) {
    const present = new Set(result.map((rule) => rule.id));
    const extras: RetrievedRule[] = [];
    for (const rule of ordered) {
      for (const relatedId of rule.related_rules ?? []) {
        if (present.has(relatedId)) continue;
        const related = byId.get(relatedId);
        if (related === undefined || related.applies_when.none_features?.some(f => features.has(f))) continue;
        present.add(relatedId);
        const retrieved = toRetrievedRule(related, features, includeRationale);
        retrieved.via = 'related';
        retrieved.via_rule = rule.id;
        retrieved.estimated_tokens = estimateTokens(renderRule(retrieved));
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

    for (const rule of kept) {
      if (estimateTokens(ruleContext([...budgeted, rule])) > options.tokenBudget) {
        truncated = true;
        continue;
      }
      budgeted.push(rule);

    }
    kept = budgeted;
  }

  return {
    rules: kept,
    unmatchedFeatures,
    truncated,
    droppedRuleIds: result.filter(r => !kept.some(k => k.id === r.id)).map(r => r.id),
    estimatedTokens: estimateTokens(ruleContext(kept)),
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
