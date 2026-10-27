/**
 * Phase 1 evaluation runner.
 *
 * Compares three retrieval strategies (01-phase1 §10):
 *   baseline : no injected knowledge
 *   rag      : BM25 chunks over the knowledge documents
 *   rules    : semantic features + atomic rule retrieval (this engine)
 *
 * Offline (deterministic) metrics: Retrieval Precision / Recall / F1,
 * Context Token Cost, violation precision/recall, compliant false positives.
 * Agent-in-the-loop metrics (Rule Compliance / Compile Rate) are computed from
 * `results/<strategy>/<caseId>.java` when those files exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyJava } from './java.ts';
import { ruleCompliance } from './agent.ts';
import type { RetrievalStrategy, RetrievedChunk } from '../src/domain/types.ts';
import { RuleEngine } from '../src/api/engine.ts';
import { loadCases, readCaseFile, writeJson } from './cases.ts';
import { markdownTable, mean, percent, round, setMetrics, sum, type SetMetrics } from './metrics.ts';

export interface EvalOptions {
  casesDir: string;
  /** Output directory (prompts / results / report). */
  outputDir: string;
  strategies?: readonly RetrievalStrategy[];
  /** Soft token budget for injected knowledge (default 1200). */
  tokenBudget?: number;
  /** RAG top-K (default 5). */
  topK?: number;
  /** Write `prompts/<strategy>/<caseId>.md`. */
  emitPrompts?: boolean;
  /** Also evaluate `results/<strategy>/<caseId>.java` when present. */
  evaluateAgentResults?: boolean;
  engine?: RuleEngine;
}

export interface StrategyCaseResult {
  case_id: string;
  strategy: RetrievalStrategy;
  expected_rules: string[];
  retrieved_rules: string[];
  expected_features: string[];
  retrieved_features: string[];
  rule_metrics: SetMetrics;
  feature_metrics: SetMetrics;
  /** Injected knowledge tokens without any budget trimming (rule payload / chunks). */
  context_tokens: number;
  /** Injected knowledge tokens when applying the configured token budget. */
  context_tokens_budgeted: number;
  /** Fraction of the expected rules whose referenced knowledge section was retrieved (RAG only). */
  reference_recall?: number;
  prompt_tokens: number;
  prompt_path?: string;
}

export interface ValidateCaseResult {
  case_id: string;
  target: 'bad' | 'good';
  reported_violations: string[];
  expected_violations: string[];
  metrics: SetMetrics;
  errors: number;
  warnings: number;
  infos: number;
  checked_rules: number;
}

export interface AgentCaseResult {
  case_id: string;
  strategy: RetrievalStrategy;
  file: string;
  violations: number;
  errors: number;
  compliance: number | null;
  behavior: 'passed' | 'failed' | 'unavailable';
  diagnostics: string;
  compile: 'ok' | 'failed' | 'unavailable';
  violation_rules: string[];
}

export interface StrategySummary {
  strategy: RetrievalStrategy;
  cases: number;
  /** False for baseline / rag: they do not produce atomic rules at all. */
  rule_retrieval_applicable: boolean;
  rule_precision: number;
  rule_recall: number;
  rule_f1: number;
  feature_precision: number;
  feature_recall: number;
  feature_f1: number;
  avg_context_tokens: number;
  avg_context_tokens_budgeted: number;
  avg_retrieved_rules: number;
  context_tokens_total: number;
  /** Mean reference recall (RAG only), undefined for the other strategies. */
  reference_recall?: number;
}

export interface EvalReport {
  generated_at: string;
  rule_count: number;
  case_count: number;
  token_budget: number;
  strategies: StrategySummary[];
  retrieval: StrategyCaseResult[];
  validation: ValidateCaseResult[];
  agent: AgentCaseResult[];
  notes: string[];
}
export function runEvaluation(options: EvalOptions): EvalReport {
  const engine = options.engine ?? RuleEngine.load();
  const cases = loadCases(options.casesDir);
  const strategies = options.strategies ?? (['baseline', 'rag', 'rules'] as const);
  const tokenBudget = options.tokenBudget ?? 1200;
  const topK = options.topK ?? 5;
  const notes: string[] = [];

  const retrieval: StrategyCaseResult[] = [];
  const validation: ValidateCaseResult[] = [];
  const agent: AgentCaseResult[] = [];

  mkdirSync(options.outputDir, { recursive: true });

  for (const strategy of strategies) {
    for (const testCase of cases) {
      const code = readCaseFile(testCase, 'before') ?? readCaseFile(testCase, 'bad') ?? readCaseFile(testCase, 'good') ?? '';
      const filePath = testCase.files.before ?? testCase.files.bad ?? testCase.files.good;
      const promptResult = engine.buildPrompt({
        task: testCase.task,
        strategy,
        caseId: testCase.id,
        ...(filePath === undefined ? {} : { filePath }),
        code,
        tokenBudget,
        topK,
      });

      // Retrieval quality is measured without the token budget: a low budget must
      // not be reported as a retrieval miss. The budgeted cost is reported separately.
      const unbudgeted = engine.retrieve({
        code,
        ...(filePath === undefined ? {} : { filePath }),
        includeRelated: false,
      });
      const retrievedRules = strategy === 'rules' ? unbudgeted.rules.map((rule) => rule.id) : [];
      const retrievedFeatures = strategy === 'rules' ? unbudgeted.features : [];
      const result: StrategyCaseResult = {
        case_id: testCase.id,
        strategy,
        expected_rules: testCase.expected.rules,
        retrieved_rules: retrievedRules,
        expected_features: testCase.expected.features,
        retrieved_features: retrievedFeatures,
        rule_metrics: setMetrics(retrievedRules, testCase.expected.rules, testCase.expected.optional_rules),
        feature_metrics: setMetrics(retrievedFeatures, testCase.expected.features),
        context_tokens: strategy === 'rules' ? unbudgeted.stats.estimated_tokens : promptResult.context_tokens,
        context_tokens_budgeted: promptResult.context_tokens,
        prompt_tokens: promptResult.estimated_tokens,
      };
      if (strategy === 'rag') {
        const recall = referenceRecall(engine, testCase.expected.rules, promptResult.chunks ?? []);
        if (recall !== undefined) result.reference_recall = recall;
      }
      if (options.emitPrompts === true) {
        const dir = join(options.outputDir, 'prompts', strategy);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${testCase.id}.md`);
        writeFileSync(path, `${promptResult.prompt}\n`, 'utf8');
        result.prompt_path = path;
      }
      retrieval.push(result);
    }
  }

  for (const testCase of cases) {
    for (const target of ['bad', 'good'] as const) {
      const code = readCaseFile(testCase, target);
      if (code === undefined) continue;
      const filePath = testCase.files[target];
      const expected = target === 'bad' ? testCase.expected.violations : testCase.expected.compliant_violations;
      const result = engine.validate({
        code,
        ...(filePath === undefined ? {} : { filePath }),
      });
      validation.push({
        case_id: testCase.id,
        target,
        reported_violations: result.violations.map((violation) => violation.rule_id),
        expected_violations: expected,
        metrics: setMetrics(result.violations.map((violation) => violation.rule_id), expected),
        errors: result.violations.filter((item) => item.severity === 'error').length,
        warnings: result.violations.filter((item) => item.severity === 'warning').length,
        infos: result.violations.filter((item) => item.severity === 'info').length,
        checked_rules: result.stats.checked_rules,
      });
    }
  }
  if (options.evaluateAgentResults === true) {
    for (const strategy of strategies) {
      for (const testCase of cases) {
        const file = join(options.outputDir, 'results', strategy, `${testCase.id}.java`);
        if (!existsSync(file)) continue;
        const result = engine.validate({ code: readFileSync(file, 'utf8'), filePath: file });
        const java = verifyJava(readFileSync(file, 'utf8'));
        agent.push({
          case_id: testCase.id,
          strategy,
          file,
          violations: result.stats.violations,
          errors: result.violations.filter((item) => item.severity === 'error').length,
          compliance: ruleCompliance(result.checked_rules, result.violations.map(v => v.rule_id), result.stats.parse_errors),
          ...java,
          violation_rules: result.violations.map((violation) => violation.rule_id),
        });
      }
    }
    if (agent.length === 0) {
      notes.push('results/<strategy>/<caseId>.java 为空：Rule Compliance / Compile Rate 需要 Agent 产出后重新运行。');
    }
  } else {
    notes.push('未启用 Agent 在环评测（--agent-results）：Rule Compliance / Compile Rate 需要 Agent 产出。');
  }
  notes.push('Agent 结果使用真实 javac 编译；缺少 JDK 时为 unavailable，缺少第三方依赖时为 failed。原有静态用例无行为契约；功能与真实 token 对比请运行 npm run eval:agent。');

  return {
    generated_at: new Date().toISOString(),
    rule_count: engine.rules().length,
    case_count: cases.length,
    token_budget: tokenBudget,
    strategies: summarizeStrategies(retrieval, strategies),
    retrieval,
    validation,
    agent,
    notes,
  };
}

/**
 * RAG-only metric: fraction of the expected rules whose referenced knowledge
 * section (e.g. `java-thread-pool-best-practices.md §有界队列应该设置多大？`)
 * actually appeared in the retrieved chunks.
 */
export function referenceRecall(engine: RuleEngine, expectedRuleIds: readonly string[], chunks: readonly RetrievedChunk[]): number | undefined {
  const expected = new Set<string>();
  for (const ruleId of expectedRuleIds) {
    for (const reference of engine.rule(ruleId)?.references ?? []) expected.add(normalizeReference(reference));
  }
  if (expected.size === 0) return undefined;
  const headings = chunks.map((chunk) => normalizeReference(chunk.heading));
  let found = 0;
  for (const reference of expected) {
    if (headings.some((heading) => heading.includes(reference) || reference.includes(heading))) found += 1;
  }
  return round(found / expected.size);
}

function normalizeReference(text: string): string {
  return text.toLowerCase().replace(/[\s§]+/g, '');
}

function summarizeStrategies(
  results: readonly StrategyCaseResult[],
  strategies: readonly RetrievalStrategy[],
): StrategySummary[] {
  const summary2: StrategySummary[] = [];
  for (const strategy of strategies) {
    const subset = results.filter((result) => result.strategy === strategy);
    const summary: StrategySummary = {
      strategy,
      cases: subset.length,
      rule_retrieval_applicable: strategy === 'rules',
      rule_precision: round(mean(subset.map((result) => result.rule_metrics.precision))),
      rule_recall: round(mean(subset.map((result) => result.rule_metrics.recall))),
      rule_f1: round(mean(subset.map((result) => result.rule_metrics.f1))),
      feature_precision: round(mean(subset.map((result) => result.feature_metrics.precision))),
      feature_recall: round(mean(subset.map((result) => result.feature_metrics.recall))),
      feature_f1: round(mean(subset.map((result) => result.feature_metrics.f1))),
      avg_context_tokens: Math.round(mean(subset.map((result) => result.context_tokens))),
      avg_context_tokens_budgeted: Math.round(mean(subset.map((result) => result.context_tokens_budgeted))),
      avg_retrieved_rules: round(mean(subset.map((result) => result.retrieved_rules.length)), 1),
      context_tokens_total: sum(subset.map((result) => result.context_tokens)),
    };
    const referenceRecalls = subset.map((result) => result.reference_recall).filter((value): value is number => value !== undefined);
    if (referenceRecalls.length > 0) summary.reference_recall = round(mean(referenceRecalls));
    summary2.push(summary);
  }
  return summary2;
}

export function writeReport(report: EvalReport, outputDir: string): { markdownPath: string; jsonPath: string } {
  const markdownPath = join(outputDir, 'report.md');
  const jsonPath = join(outputDir, 'report.json');
  writeFileSync(markdownPath, renderReportMarkdown(report), 'utf8');
  writeJson(jsonPath, report);
  return { markdownPath, jsonPath };
}
export function renderReportMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('# Phase 1 Evaluation Report');
  lines.push('');
  lines.push(`生成时间: ${report.generated_at}`);
  lines.push(`规则总数: ${report.rule_count} | 用例数: ${report.case_count} | 注入预算: ${report.token_budget} tokens`);
  lines.push('');
  lines.push('## 1. 检索策略对比（Baseline vs RAG vs Rule Retrieval）');
  lines.push('');
  lines.push(
    markdownTable(
      ['Strategy', 'Rule P', 'Rule R', 'Rule F1', 'Feature P', 'Feature R', 'Ref Recall (RAG)', 'Avg Context Tokens', 'Avg Budgeted Tokens', 'Avg Rules'],
      report.strategies.map((entry) => {
        const na = entry.rule_retrieval_applicable;
        return [
          entry.strategy,
          na ? percent(entry.rule_precision) : 'n/a',
          na ? percent(entry.rule_recall) : 'n/a',
          na ? percent(entry.rule_f1) : 'n/a',
          na ? percent(entry.feature_precision) : 'n/a',
          na ? percent(entry.feature_recall) : 'n/a',
          entry.reference_recall === undefined ? 'n/a' : percent(entry.reference_recall),
          String(entry.avg_context_tokens),
          String(entry.avg_context_tokens_budgeted),
          String(entry.avg_retrieved_rules),
        ];
      }),
    ),
  );
  lines.push('');
  lines.push('> baseline / rag 不产出 Atomic Rule，因此规则与语义特征指标标记为 n/a；RAG 用 Ref Recall 衡量"检索到的文档片段是否覆盖期望规则引用的章节"。');
  lines.push('');
  lines.push('## 2. validate 准确性（bad.java / good.java）');
  lines.push('');
  const bad = report.validation.filter((entry) => entry.target === 'bad');
  const good = report.validation.filter((entry) => entry.target === 'good');
  lines.push(
    markdownTable(
      ['Target', 'Cases', 'Violation P', 'Violation R', 'Errors', 'Warnings'],
      [
        [
          'bad.java (命中期望违规)',
          String(bad.length),
          percent(mean(bad.map((entry) => entry.metrics.precision))),
          percent(mean(bad.map((entry) => entry.metrics.recall))),
          String(sum(bad.map((entry) => entry.errors))),
          String(sum(bad.map((entry) => entry.warnings))),
        ],
        [
          'good.java (应为 0 个 error)',
          String(good.length),
          percent(mean(good.map((entry) => entry.metrics.precision))),
          percent(mean(good.map((entry) => entry.metrics.recall))),
          String(sum(good.map((entry) => entry.errors))),
          String(sum(good.map((entry) => entry.warnings))),
        ],
      ],
    ),
  );
  lines.push('');
  const falsePositives = good.filter((entry) => entry.errors > 0);
  if (falsePositives.length > 0) {
    lines.push('### 误报（合规代码被判为 error）');
    lines.push('');
    for (const entry of falsePositives) lines.push(`- ${entry.case_id}: ${entry.reported_violations.join(', ')}`);
    lines.push('');
  }
  lines.push('## 3. Agent 在环指标');
  lines.push('');
  if (report.agent.length === 0) {
    lines.push('暂无 Agent 产出，Rule Compliance Rate / Compile Rate 待回填。');
    lines.push('');
    lines.push('操作方式：把 `prompts/<strategy>/<caseId>.md` 交给 Cline 执行，把产出的 Java 代码放到');
    lines.push('`results/<strategy>/<caseId>.java`，再运行 `npm run engine -- eval --agent-results`。');
  } else {
    lines.push(
      markdownTable(
        ['Strategy', 'Cases', 'Avg Compliance', 'Errors', 'Violations', 'Compile'],
        report.strategies.map((entry) => {
          const subset = report.agent.filter((item) => item.strategy === entry.strategy);
          return [
            entry.strategy,
            String(subset.length),
            subset.some(item => item.compliance !== null) ? percent(mean(subset.map((item) => item.compliance).filter((v): v is number => v !== null))) : 'n/a',
            String(sum(subset.map((item) => item.errors))),
            String(sum(subset.map((item) => item.violations))),
            subset.length === 0 ? 'n/a' : `${subset.filter(item => item.compile === 'ok').length}/${subset.length} ok; ${subset.filter(item => item.compile === 'unavailable').length} unavailable`,
          ];
        }),
      ),
    );
  }
  lines.push('');
  lines.push('## 4. 说明');
  lines.push('');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('## 5. 检索明细（rules 策略）');
  lines.push('');
  lines.push(
    markdownTable(
      ['Case', 'Expected', 'Retrieved', 'P', 'R', 'Context Tokens'],
      report.retrieval
        .filter((entry) => entry.strategy === 'rules')
        .map((entry) => [
          entry.case_id,
          String(entry.expected_rules.length),
          String(entry.retrieved_rules.length),
          percent(entry.rule_metrics.precision),
          percent(entry.rule_metrics.recall),
          String(entry.context_tokens),
        ]),
    ),
  );
  lines.push('');
  lines.push('## 6. validate 明细');
  lines.push('');
  lines.push(
    markdownTable(
      ['Case', 'Target', 'Expected', 'Reported', 'P', 'R'],
      report.validation.map((entry) => [
        entry.case_id,
        entry.target,
        entry.expected_violations.join(' ') || '-',
        entry.reported_violations.join(' ') || '-',
        percent(entry.metrics.precision),
        percent(entry.metrics.recall),
      ]),
    ),
  );
  lines.push('');
  return lines.join('\n');
}
