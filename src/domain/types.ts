/**
 * Core domain types of the Knowledge Rule Engine (Phase 1 PoC).
 *
 * Contract references (see 00-overview.md / 01-phase1-rule-engine-poc.md):
 *  - Atomic Rule      -> `Rule`
 *  - Semantic Feature -> `FeatureId` / `FeatureHit`
 *  - retrieve API     -> `RetrieveResult`
 *  - validate API     -> `ValidateResult`
 */

/** Severity of a rule and of the violations it produces. */
export type Severity = 'error' | 'warning' | 'info';

/** Retrieval priority of a rule; used for ordering and token-budget trimming. */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

export const PRIORITY_ORDER: Readonly<Record<Priority, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** A `DOMAIN.SLICE.FEATURE` identifier, e.g. `THREAD_POOL.CONFIG.QUEUE`. */
export type FeatureId = string;

/** One-based position inside a source file. */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** A span plus the source text it covers, used as evidence for a finding. */
export interface Evidence extends SourceSpan {
  /** First line of the covered source text, trimmed. */
  snippet: string;
  /** Optional symbol name (variable, method, class) the evidence belongs to. */
  symbol?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

/** A semantic feature detected in the analysed code, with its evidence. */
export interface FeatureHit extends Evidence {
  feature: FeatureId;
  /** AST node type that produced the hit, e.g. `object_creation_expression`. */
  nodeType: string;
  confidence: Confidence;
  /** Free-form, machine readable attributes (queue type, policy, ...). */
  attributes: Record<string, string | number | boolean>;
}

/** Rule applicability: which semantic features make the rule relevant. */
export interface RuleApplicability {
  /** All of these features must be present (AND). */
  features?: FeatureId[];
  /** At least one of these features must be present (OR). */
  any_features?: FeatureId[];
  /** None of these features may be present (NOT). */
  none_features?: FeatureId[];
}

/** Declarative reference to the deterministic checker that produces violations. */
export interface RuleCheck {
  /** Name of a checker in the validator registry, e.g. `thread_pool.queue_bounded`. */
  validator: string;
  /** Checker parameters (thresholds, allow-lists, ...). */
  params?: Record<string, unknown>;
}

/** A code snippet used as positive / negative example of a rule. */
export interface RuleExample {
  code: string;
  note?: string;
}


export interface Rule {
  /** Globally unique rule id, e.g. `TP-QUEUE-001`. */
  id: string;
  name: string;
  /** Domain path, e.g. `["java", "concurrency", "thread_pool"]`. */
  domain: string[];
  language: string;
  applies_when: RuleApplicability;
  /** Short description of the constraint. */
  description: string;
  /** Rule text injected into the agent context. */
  content: string;
  rationale?: string;
  severity: Severity;
  priority: Priority;
  /** Deterministic checker; rules without a check are advisory only. */
  check?: RuleCheck;
  examples?: {
    positive?: RuleExample[];
    negative?: RuleExample[];
  };
  related_rules?: string[];
  /** Human readable references (section of the source knowledge, links, ...). */
  references?: string[];
  tags?: string[];
  /** Path of the YAML file the rule was loaded from (filled by the repository). */
  source?: string;
}

/** A rule returned by `retrieve`, together with the features that matched it. */
export interface RetrievedRule {
  id: string;
  name: string;
  severity: Severity;
  priority: Priority;
  description: string;
  content: string;
  rationale?: string;
  /** Features required by `applies_when` that were found in the code. */
  matched_features: FeatureId[];
  /** How the rule entered the result: directly matched or via `related_rules`. */
  via: 'applies_when' | 'related';
  /** Rule id that pulled this rule in when `via === 'related'`. */
  via_rule?: string;
  related_rules: string[];
  references: string[];
  /** Estimated token cost of the injected rule text. */
  estimated_tokens: number;
}

export interface AnalyzedFeature {
  id: FeatureId;
  description: string;
  hits: number;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface AnalyzeStats {
  /** Rules whose `applies_when` was evaluated (all rules of the repository). */
  candidate_rules: number;
  /** Rules returned to the caller. */
  matched_rules: number;
  /** Estimated tokens of the rendered rule payload. */
  estimated_tokens: number;
  /** Parse problems (syntax errors) found by the Java parser. */
  parse_errors: number;
  /** Milliseconds spent in the analyzer. */
  analyze_ms: number;
}

/** Result of `retrieve(code, filePath, task?)` (01-phase1 §8). */
export interface RetrieveResult {
  selection?: { dropped_rule_ids: string[]; unmatched_features: string[]; planned_features: string[] };
  file_path: string;
  language: string;
  /** Task / user intent the code was retrieved for, when provided. */
  task?: string;
  /** Detected semantic features, in catalog order. */
  features: FeatureId[];
  feature_details: AnalyzedFeature[];
  /** Applicable atomic rules, ordered by priority then id. */
  rules: RetrievedRule[];
  stats: AnalyzeStats;
  /** Non fatal problems of the analyzer (unsupported syntax, ...). */
  warnings: string[];
}

export interface Violation {
  rule_id: string;
  rule_name: string;
  message: string;
  severity: Severity;
  /** One-based line of the offending code. */
  line: number;
  /** One-based column of the offending code. */
  column: number;
  /** Source text of the offending code (single line, trimmed). */
  snippet: string;
  /** Concrete repair hint for the agent. */
  suggestion: string;
  /** Additional evidence spans that support the finding. */
  evidence?: Evidence[];
}

/** Result of `validate(code, ruleIds?)` (01-phase1 §8). */
export interface ValidateResult {
  /** Execution coverage, never a compilation/business-correctness verdict. */
  status?: 'complete' | 'partial' | 'invalid';
  checks?: Array<{ rule_id: string; status: 'passed' | 'violated' | 'advisory' | 'unavailable'; reason?: string }>;
  file_path: string;
  language: string;
  features: FeatureId[];
  /** Rules that were actually evaluated against the code. */
  checked_rules: string[];
  violations: Violation[];
  stats: {
    checked_rules: number;
    violations: number;
    parse_errors: number;
  };
  warnings: string[];
}

export type RetrievalStrategy = 'baseline' | 'rag' | 'rules';

export interface RetrievedChunk {
  source: string;
  heading: string;
  text: string;
  score: number;
  estimated_tokens: number;
}

/** Rendered prompt for the "first agent experiment" (01-phase1 §9). */
export interface RenderedPrompt {
  case_id?: string;
  task: string;
  strategy: RetrievalStrategy;
  features?: FeatureId[];
  rule_ids?: string[];
  chunks?: RetrievedChunk[];
  /** Full prompt text that can be pasted into Cline. */
  prompt: string;
  estimated_tokens: number;
}

export interface EngineOptions {
  /** Directory holding `<language>/<domain>/*.yaml` rule files. */
  knowledgeDir?: string;
  /** Directory holding the RAG document corpus (defaults to the repository root `*.md`). */
  corpusDir?: string;
}
