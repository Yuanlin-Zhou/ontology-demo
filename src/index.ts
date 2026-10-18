/**
 * Library entry point of the Knowledge Rule Engine.
 *
 * Phase 2 (Cline integration) will wrap `RuleEngine.retrieve` and
 * `RuleEngine.validate` as the `knowledge_retrieve` / `knowledge_validate` tools.
 */
export { RuleEngine, REPOSITORY_ROOT, DEFAULT_KNOWLEDGE_DIR } from './api/engine.ts';
export type { RetrieveInput, AnalysisResult, PromptBuildInput } from './api/engine.ts';
export { RuleRepository, RuleValidationError } from './matcher/rule-repository.ts';
export { matchRules, isApplicable } from './matcher/rule-matcher.ts';
export { validateCode } from './validator/rule-validator.ts';
export { getValidator, registerValidator, validatorNames } from './validator/validator-registry.ts';
export { parseJava, evidenceOf } from './analyzer/java-parser.ts';
export { buildThreadPoolModel, analyzeJavaFile } from './analyzer/model-builder.ts';
export { detectFeatures, featureIdsOf, summarizeFeatures } from './analyzer/feature-detector.ts';
export { FEATURE_CATALOG, describeFeature, featureGroup } from './domain/features.ts';
export { estimateTokens, formatTokens } from './retrieval/token-estimator.ts';
export { renderPrompt } from './retrieval/prompt-renderer.ts';
export { RagBaseline, tokenize } from './retrieval/rag-baseline.ts';
export { loadCases, readCaseFile } from '../eval/cases.ts';
export { runEvaluation, writeReport, renderReportMarkdown } from '../eval/runner.ts';
export type * from './domain/types.ts';
export type { JavaThreadPoolModel, PoolCreationFact, SubmitFact, ShutdownFact } from './analyzer/model.ts';
export type { EvaluationCase } from '../eval/cases.ts';
export type { EvalReport, EvalOptions } from '../eval/runner.ts';
