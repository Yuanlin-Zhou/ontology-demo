/**
 * Public API of the Knowledge Rule Engine.
 *
 * These two capabilities are what Phase 2 will expose to Cline as
 * `knowledge_retrieve` / `knowledge_validate` (01-phase1 §8).
 */
import { resolve } from 'node:path';
import { detectFeatures, featureIdsOf, summarizeFeatures } from '../analyzer/feature-detector.ts';
import { parseJava, type ParsedJavaFile } from '../analyzer/java-parser.ts';
import { buildThreadPoolModel } from '../analyzer/model-builder.ts';
import type { JavaThreadPoolModel } from '../analyzer/model.ts';
import { FEATURE_CATALOG } from '../domain/features.ts';
import type { AnalyzeStats, FeatureHit, RetrievalStrategy, RetrieveResult, RetrievedChunk, Rule, ValidateResult } from '../domain/types.ts';
import { ruleContext } from '../retrieval/knowledge-payload.ts';
import { matchRules, toRetrievedRule, type MatchOptions } from '../matcher/rule-matcher.ts';
import { RuleRepository } from '../matcher/rule-repository.ts';
import { RagBaseline, type RagOptions } from '../retrieval/rag-baseline.ts';
import { renderPrompt, type PromptInput, type RenderPromptResult } from '../retrieval/prompt-renderer.ts';
import { estimateTokens } from '../retrieval/token-estimator.ts';
import { repairCode, type RepairInput, type RepairResult } from './repair.ts';
import { getValidator } from '../validator/validator-registry.ts';
import { validateAnalysis, validateCode, type ValidateOptions } from '../validator/rule-validator.ts';

/** Repository root (two levels above `src/api`). */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
export const DEFAULT_KNOWLEDGE_DIR = resolve(REPOSITORY_ROOT, 'knowledge');

export interface RetrieveInput {
  code: string;
  filePath?: string;
  /** Original user task; only used for prompt rendering, not for matching. */
  task?: string;
  includeRelated?: boolean;
  includeRationale?: boolean;
  maxRules?: number;
  tokenBudget?: number;
  /** Explicit planned capabilities for empty/new code; never inferred from task keywords. */
  featureHints?: string[];
}

export interface AnalysisResult {
  filePath: string;
  parsed: ParsedJavaFile;
  model: JavaThreadPoolModel;
  hits: FeatureHit[];
  featureIds: string[];
  features: ReturnType<typeof summarizeFeatures>;
}

export interface PromptBuildInput {
  task: string;
  strategy: RetrievalStrategy;
  caseId?: string;
  filePath?: string;
  code?: string;
  includeCode?: boolean;
  /** Include conditional related advice (default false). */
  includeRelated?: boolean;
  /** Hard estimated-token budget for serialized knowledge (default 1200). */
  tokenBudget?: number;
  /** Top-K for the RAG strategy (default 5). */
  topK?: number;
  featureHints?: string[];
}

export interface RenderedPromptResult {
  context_tokens: number;
  prompt: string;
  estimated_tokens: number;
  features?: string[];
  rule_ids?: string[];
  chunks?: RetrievedChunk[];
}

export class RuleEngine {
  readonly repository: RuleRepository;
  readonly corpusDir: string;
  private readonly rag: RagBaseline;

  constructor(repository: RuleRepository, corpusDir: string = REPOSITORY_ROOT) {
    for (const rule of repository.rules) {
      if (rule.check && !getValidator(rule.check.validator)) throw new Error(`${rule.id}: unregistered checker ${rule.check.validator}`);
    }
    this.repository = repository;
    this.corpusDir = corpusDir;
    this.rag = new RagBaseline(corpusDir);
  }

  /** Synchronously loads the knowledge base from disk. */
  static load(options: { knowledgeDir?: string; corpusDir?: string; strictFeatures?: boolean } = {}): RuleEngine {
    const knowledgeDir = options.knowledgeDir ?? DEFAULT_KNOWLEDGE_DIR;
    const repository = RuleRepository.load({
      knowledgeDir,
      ...(options.strictFeatures === undefined ? {} : { strictFeatures: options.strictFeatures }),
    });
    return new RuleEngine(repository, options.corpusDir ?? REPOSITORY_ROOT);
  }

  rules(): Rule[] {
    return this.repository.rules;
  }

  rule(id: string): Rule | undefined {
    return this.repository.get(id);
  }

  featureCatalog(): typeof FEATURE_CATALOG {
    return FEATURE_CATALOG;
  }

  /** Parses and analyses a Java file (semantic features + structured model). */
  analyze(input: { code: string; filePath?: string }): AnalysisResult {
    const filePath = input.filePath ?? '<inline>.java';
    const parsed = parseJava(input.code, filePath);
    const model = buildThreadPoolModel(parsed);
    const hits = detectFeatures(model);
    return { filePath, parsed, model, hits, featureIds: featureIdsOf(hits), features: summarizeFeatures(hits) };
  }
  /** `retrieve(code, filePath, task?)` -> applicable atomic rules. */
  retrieve(input: RetrieveInput): RetrieveResult {
    const startedAt = Date.now();
    const analysis = this.analyze(input);
    const matchOptions: MatchOptions = {};
    if (input.includeRelated !== undefined) matchOptions.includeRelated = input.includeRelated;
    if (input.includeRationale !== undefined) matchOptions.includeRationale = input.includeRationale;
    if (input.maxRules !== undefined) matchOptions.maxRules = input.maxRules;
    if (input.tokenBudget !== undefined) matchOptions.tokenBudget = input.tokenBudget;

    const diagnostics = validateAnalysis(this.repository.rules, analysis.parsed, analysis.model);
    matchOptions.violatedRuleIds = diagnostics.violations.map(v => v.rule_id);
    const hints = input.featureHints ?? [];
    for (const hint of hints) if (!FEATURE_CATALOG.some(f => f.id === hint)) throw new Error(`Unknown planned feature: ${hint}`);
    const match = matchRules(this.repository, analysis.parsed.errors.length ? [] : [...new Set([...analysis.featureIds, ...hints])], matchOptions);
    const stats: AnalyzeStats = {
      candidate_rules: this.repository.rules.length,
      matched_rules: match.rules.length,
      estimated_tokens: match.estimatedTokens,
      parse_errors: analysis.parsed.errors.length,
      analyze_ms: Date.now() - startedAt,
    };
    const result: RetrieveResult = {
      file_path: analysis.filePath,
      language: 'java',
      features: analysis.featureIds,
      feature_details: analysis.features,
      rules: analysis.parsed.errors.length ? [] : match.rules,
      selection: { dropped_rule_ids: match.droppedRuleIds, unmatched_features: match.unmatchedFeatures, planned_features: hints },
      stats,
      warnings: analysis.parsed.errors.map((error) => `L${error.line}:${error.column} ${error.message}`),
    };
    if (input.task !== undefined) result.task = input.task;
    if (analysis.parsed.errors.length) result.warnings.push('源码语法错误：暂停规则注入，先修复语法后重新分析。');
    if (match.truncated) result.warnings.push('规则结果已按 maxRules/tokenBudget 截断');
    return result;
  }

  /** `validate(code, ruleIds?)` -> violations of the applicable rules. */
  validate(input: { code: string; filePath?: string; ruleIds?: readonly string[] }): ValidateResult {
    const options: ValidateOptions = input.ruleIds === undefined ? {} : { ruleIds: input.ruleIds };
    return validateCode(this.repository.rules, input.code, input.filePath ?? '<inline>.java', options);
  }

  /** Compiler/business-gated, bounded Retrieve → Validate → Repair loop. */
  repair(input: RepairInput): Promise<RepairResult> { return repairCode(this, input); }

  /** Naive RAG baseline over the knowledge documents (used by the evaluation). */
  retrieveChunks(query: string, options: RagOptions = {}): RetrievedChunk[] {
    return this.rag.retrieve(query, options);
  }

  /** Renders a prompt for the Phase 1 agent experiment (01-phase1 §9). */
  renderPrompt(input: PromptInput): RenderedPromptResult {
    return renderPrompt(input);
  }

  /**
   * Builds the prompt of a given strategy, performing the retrieval the
   * strategy requires (baseline: nothing, rag: BM25 chunks, rules: retrieve()).
   */
  buildPrompt(input: PromptBuildInput): RenderPromptResult {
    const tokenBudget = input.tokenBudget ?? 1200;
    const includeCode = input.includeCode ?? true;
    const base = {
      task: input.task,
      strategy: input.strategy,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
      ...(input.code === undefined ? {} : { code: input.code }),
      includeCode,
    } satisfies Omit<PromptInput, 'rules' | 'chunks' | 'features'>;

    if (input.strategy === 'rag') {
      const query = `${input.task}\n${input.code ?? ''}`;
      const chunks = this.retrieveChunks(query, { topK: input.topK ?? 5, tokenBudget });
      return renderPrompt({ ...base, chunks });
    }
    if (input.strategy === 'rules') {
      const retrieved = this.retrieve({
        code: input.code ?? '',
        ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
        task: input.task,
        tokenBudget,
        includeRelated: input.includeRelated ?? false,
        ...(input.featureHints === undefined ? {} : { featureHints: input.featureHints }),
      });
      return { ...renderPrompt({ ...base, features: retrieved.features, rules: retrieved.rules }),
        warnings: retrieved.warnings, dropped_rule_ids: retrieved.selection?.dropped_rule_ids ?? [] };
    }
    return renderPrompt(base);
  }

  /** Token cost of a rule payload, used for budget planning. */
  estimateRuleTokens(ruleIds: readonly string[]): number {
    return estimateTokens(ruleContext(this.repository.byIds(ruleIds).map(rule => toRetrievedRule(rule, new Set(), false))));
  }
}

export { matchRules, isApplicable } from '../matcher/rule-matcher.ts';
export { validateCode } from '../validator/rule-validator.ts';
export type { RetrievedRule, RetrieveResult, ValidateResult, Rule } from '../domain/types.ts';
