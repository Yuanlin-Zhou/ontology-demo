/**
 * Dev analysis: the RAG token-vs-recall curve.
 *
 * For every evaluation case we ask "how much context does plain RAG need to
 * surface the knowledge sections that the applicable atomic rules point at?".
 * The rule-retrieval strategy answers the same question by injecting the rules
 * themselves (its payload token cost is printed for comparison), which is what
 * makes the "Context Token ↓ / Precision ↑" claim measurable.
 *
 *   node scripts/rag-sweep.ts
 */
import { join } from 'node:path';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { loadCases, readCaseFile } from '../eval/cases.ts';
import { referenceRecall } from '../eval/runner.ts';
import { mean, percent } from '../eval/metrics.ts';

const BUDGETS = [500, 1000, 2000, 4000, 8000, 20000];

const engine = RuleEngine.load();
const cases = loadCases(join(REPOSITORY_ROOT, 'cases'));

interface Row {
  budget: number;
  recall: number;
  tokens: number;
  chunks: number;
}

const rows: Row[] = [];
for (const budget of BUDGETS) {
  const recalls: number[] = [];
  const tokens: number[] = [];
  const chunkCounts: number[] = [];
  for (const testCase of cases) {
    const code = readCaseFile(testCase, 'before') ?? readCaseFile(testCase, 'bad') ?? readCaseFile(testCase, 'good') ?? '';
    const chunks = engine.retrieveChunks(`${testCase.task}\n${code}`, { topK: 50, tokenBudget: budget });
    const recall = referenceRecall(engine, testCase.expected.rules, chunks);
    if (recall !== undefined) recalls.push(recall);
    tokens.push(chunks.reduce((sum, chunk) => sum + chunk.estimated_tokens, 0));
    chunkCounts.push(chunks.length);
  }
  rows.push({ budget, recall: mean(recalls), tokens: Math.round(mean(tokens)), chunks: mean(chunkCounts) });
}

const rulesTokens: number[] = [];
const rulesCount: number[] = [];
for (const testCase of cases) {
  const code = readCaseFile(testCase, 'before') ?? '';
  const result = engine.retrieve({ code, includeRelated: false });
  rulesTokens.push(result.stats.estimated_tokens);
  rulesCount.push(result.rules.length);
}

console.log('RAG (BM25 chunks, topK<=50) — 期望规则引用的知识章节覆盖率 vs 注入成本');
console.log('| token 预算 | 平均注入 tokens | 平均片段数 | 章节召回率 |');
console.log('| --- | --- | --- | --- |');
for (const row of rows) {
  console.log(`| ${row.budget} | ${row.tokens} | ${row.chunks.toFixed(1)} | ${percent(row.recall)} |`);
}
console.log('');
console.log(`Rule Retrieval: 平均注入 ${Math.round(mean(rulesTokens))} tokens / ${mean(rulesCount).toFixed(1)} 条规则`);
console.log('（Rule Retrieval 的"章节召回率"为 100%：注入的就是规则本体，并且附带 references 指回知识章节）');

// 参考系：整个知识库（两篇 md）的规模，以及 RAG 在不同预算下的"完全漏掉"情况
const corpusChunks = engine.retrieveChunks('线程池 thread pool 队列 拒绝策略 关闭 监控', { topK: 500, tokenBudget: 10_000_000 });
const corpusTokens = corpusChunks.reduce((sum, chunk) => sum + chunk.estimated_tokens, 0);
console.log('');
console.log(`知识库规模（两篇 md 全量）: ${corpusTokens} tokens / ${corpusChunks.length} 个片段`);

for (const budget of [1200, 20000]) {
  const zeros: string[] = [];
  for (const testCase of cases) {
    const code = readCaseFile(testCase, 'before') ?? '';
    const chunks = engine.retrieveChunks(`${testCase.task}\n${code}`, { topK: 50, tokenBudget: budget });
    const recall = referenceRecall(engine, testCase.expected.rules, chunks);
    if (recall !== undefined && recall === 0) zeros.push(testCase.id);
  }
  console.log(`RAG 预算 ${budget}：${zeros.length}/${cases.length} 个用例的章节召回率为 0（完全没检索到对应知识）`);
}
