/**
 * Rule Validator: runs the deterministic checkers of the applicable rules
 * against a Java file and reports violations (01-phase1 §8).
 */
import { detectFeatures, featureIdsOf, summarizeFeatures } from '../analyzer/feature-detector.ts';
import { parseJava, type ParsedJavaFile } from '../analyzer/java-parser.ts';
import type { JavaThreadPoolModel } from '../analyzer/model.ts';
import { buildThreadPoolModel } from '../analyzer/model-builder.ts';
import { isApplicable } from '../matcher/rule-matcher.ts';
import type { FeatureId, Rule, ValidateResult, Violation } from '../domain/types.ts';
import { getValidator, type CheckFinding } from './validator-registry.ts';
import './checks/thread-pool-checks.ts';

export interface ValidateOptions {
  /** Restrict validation to these rule ids (also validates non-applicable rules). */
  ruleIds?: readonly string[];
}

interface AnalysisBundle {
  parsed: ParsedJavaFile;
  features: Set<FeatureId>;
}

/** Analyses the source once and hands it to the selected checkers. */
export function validateCode(rules: readonly Rule[], code: string, filePath = '<inline>.java', options: ValidateOptions = {}): ValidateResult {
  const parsed = parseJava(code, filePath);
  return validateAnalysis(rules, parsed, buildThreadPoolModel(parsed), options);
}

/** Shared analysis for retrieval diagnostics and validation, without a second AST parse. */
export function validateAnalysis(rules: readonly Rule[], parsed: ParsedJavaFile, model: JavaThreadPoolModel, options: ValidateOptions = {}): ValidateResult {
  const { code, filePath } = parsed;
  const hits = detectFeatures(model);
  const features = new Set(featureIdsOf(hits));
  const bundle: AnalysisBundle = { parsed, features };
  const warnings: string[] = parsed.errors.map((error) => `L${error.line}:${error.column} ${error.message}`);

  const selected = selectRules(rules, bundle.features, options, warnings);
  const violations: Violation[] = [];
  const checkedRules: string[] = [];
  const checks: NonNullable<ValidateResult['checks']> = [];

  for (const rule of selected) {
    if (parsed.errors.length) {
      checks.push({ rule_id: rule.id, status: 'unavailable', reason: 'Java syntax errors; repair syntax before rule validation.' });
      continue;
    }
    const checkName = rule.check?.validator;
    if (checkName === undefined) {
      checks.push({ rule_id: rule.id, status: 'advisory', reason: 'No deterministic checker.' });
      warnings.push(`${rule.id}: 规则没有 check，无法参与 validate`);
      continue;
    }
    const checker = getValidator(checkName);
    if (checker === undefined) {
      checks.push({ rule_id: rule.id, status: 'unavailable', reason: `Unregistered checker: ${checkName}` });
      warnings.push(`${rule.id}: 未注册的 checker ${checkName}`);
      continue;
    }
    const findings = checker({
      rule,
      params: rule.check?.params ?? {},
      parsed,
      model,
      features: bundle.features,
      lines: parsed.lines,
      code,
    });
    checkedRules.push(rule.id);
    checks.push({ rule_id: rule.id, status: findings.length ? 'violated' : 'passed' });
    for (const finding of findings) violations.push(toViolation(rule, finding));
  }

  violations.sort((a, b) => a.line - b.line || a.column - b.column || a.rule_id.localeCompare(b.rule_id));

  return {
    file_path: filePath,
    language: 'java',
    features: [...features],
    checked_rules: checkedRules,
    checks,
    status: parsed.errors.length ? 'invalid' : checks.some(c => c.status === 'unavailable') || warnings.some(w => w.startsWith('未知')) ? 'partial' : 'complete',
    violations,
    stats: {
      checked_rules: checkedRules.length,
      violations: violations.length,
      parse_errors: parsed.errors.length,
    },
    warnings,
  };
}

function selectRules(
  rules: readonly Rule[],
  features: ReadonlySet<FeatureId>,
  options: ValidateOptions,
  warnings: string[],
): Rule[] {
  if (options.ruleIds !== undefined) {
    const wanted = new Set(options.ruleIds);
    const known = new Set(rules.map((rule) => rule.id));
    for (const id of wanted) {
      if (!known.has(id)) warnings.push(`未知的规则 id: ${id}`);
    }
    return rules.filter((rule) => wanted.has(rule.id));
  }
  return rules.filter((rule) => isApplicable(rule, features));
}

function toViolation(rule: Rule, finding: CheckFinding): Violation {
  const violation: Violation = {
    rule_id: rule.id,
    rule_name: rule.name,
    message: finding.message,
    severity: rule.severity,
    line: finding.line,
    column: finding.column,
    snippet: finding.snippet,
    suggestion: finding.suggestion,
  };
  if (finding.evidence !== undefined) violation.evidence = finding.evidence;
  return violation;
}

/** Convenience helper used by tests and the CLI: feature summary of a file. */
export function describeCode(code: string, filePath = '<inline>.java'): ReturnType<typeof summarizeFeatures> {
  const parsed = parseJava(code, filePath);
  return summarizeFeatures(detectFeatures(buildThreadPoolModel(parsed)));
}
