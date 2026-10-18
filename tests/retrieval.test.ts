/**
 * Retrieval layer tests: RAG baseline, token estimator and prompt renderer.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { renderPrompt } from '../src/retrieval/prompt-renderer.ts';
import { RagBaseline, tokenize } from '../src/retrieval/rag-baseline.ts';
import { estimateTokens } from '../src/retrieval/token-estimator.ts';

describe('token estimator', () => {
  it('counts CJK characters higher than ASCII', () => {
    assert.ok(estimateTokens('线程池') > 0);
    assert.ok(estimateTokens('线程池队列') > estimateTokens('abc'));
    assert.equal(estimateTokens(''), 0);
  });
});

describe('tokenizer', () => {
  it('emits ascii words and CJK n-grams', () => {
    const tokens = tokenize('ThreadPoolExecutor 使用有界队列 ArrayBlockingQueue');
    assert.ok(tokens.includes('threadpoolexecutor'));
    assert.ok(tokens.includes('arrayblockingqueue'));
    assert.ok(tokens.includes('有界'));
  });
});

describe('RAG baseline', () => {
  const rag = new RagBaseline(REPOSITORY_ROOT);

  it('indexes the two knowledge documents', () => {
    const corpus = rag.corpus();
    assert.ok(corpus.includes('java-thread-pool-summary.md'), corpus.join(','));
    assert.ok(corpus.includes('java-thread-pool-best-practices.md'), corpus.join(','));
  });

  it('ranks queue-related knowledge for a queue related query', () => {
    const chunks = rag.retrieve('线程池队列容量 无界 LinkedBlockingQueue OOM', { topK: 3 });
    assert.ok(chunks.length > 0);
    const text = chunks.map((chunk) => `${chunk.heading} ${chunk.text}`).join('\n');
    assert.ok(/LinkedBlockingQueue|队列/.test(text), `expected queue related content, got: ${chunks[0]?.heading}`);
  });

  it('returns chunks with token cost and score', () => {
    const chunks = rag.retrieve('拒绝策略 CallerRunsPolicy 反压', { topK: 2 });
    for (const chunk of chunks) {
      assert.ok(chunk.estimated_tokens > 0);
      assert.ok(chunk.score > 0);
      assert.ok(chunk.text.length > 50);
    }
  });

  it('respects the token budget', () => {
    const chunks = rag.retrieve('线程池', { topK: 10, tokenBudget: 200 });
    const total = chunks.reduce((sum, chunk) => sum + chunk.estimated_tokens, 0);
    assert.ok(total <= 200 * 2, `unexpected payload ${total}`);
  });
});

describe('prompt renderer', () => {
  it('renders the rule context with feature evidence', () => {
    const engine = RuleEngine.load();
    const code = `
      class A {
        private final java.util.concurrent.ExecutorService pool =
            java.util.concurrent.Executors.newFixedThreadPool(8);
      }`;
    const rendered = engine.buildPrompt({ task: '增加异步能力', strategy: 'rules', code, filePath: 'A.java', tokenBudget: 800 });
    assert.match(rendered.prompt, /原始任务/);
    assert.match(rendered.prompt, /Applicable Engineering Rules/);
    assert.match(rendered.prompt, /THREAD_POOL\.CREATE/);
    assert.match(rendered.prompt, /TP-CREATE-001/);
    assert.ok(rendered.context_tokens > 0);
    assert.ok(rendered.estimated_tokens > rendered.context_tokens);
  });

  it('renders nothing but the task for the baseline strategy', () => {
    const rendered = renderPrompt({ task: 'do it', strategy: 'baseline', includeCode: false });
    assert.ok(!/Engineering Rules/.test(rendered.prompt));
    assert.equal(rendered.context_tokens, 0);
  });

  it('renders retrieved chunks for the rag strategy', () => {
    const engine = RuleEngine.load();
    const rendered = engine.buildPrompt({ task: '线程池队列积压怎么处理', strategy: 'rag', topK: 2, tokenBudget: 600 });
    assert.match(rendered.prompt, /Retrieved Knowledge \(RAG\)/);
    assert.ok((rendered.chunks?.length ?? 0) > 0);
  });
});

describe('retrieve API contract', () => {
  const engine = RuleEngine.load();

  it('returns features, rules and statistics', () => {
    const result = engine.retrieve({
      code: `
        class A {
          private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
              2, 4, 60L, java.util.concurrent.TimeUnit.SECONDS,
              new java.util.concurrent.ArrayBlockingQueue<>(10));
          void work() { pool.submit(() -> run()); }
        }`,
      filePath: 'A.java',
      task: '补充异步执行',
    });
    assert.equal(result.language, 'java');
    assert.ok(result.features.includes('THREAD_POOL.CREATE'));
    assert.ok(result.rules.some((rule) => rule.id === 'TP-SUBMIT-001'));
    assert.equal(result.stats.candidate_rules, 26);
    assert.ok(result.stats.estimated_tokens > 0);
    assert.equal(result.task, '补充异步执行');
    assert.ok(result.feature_details.every((feature) => feature.evidence.length > 0));
  });

  it('keeps the context small compared to the whole knowledge base', () => {
    const result = engine.retrieve({
      code: 'class A { private final java.util.concurrent.ExecutorService e = java.util.concurrent.Executors.newFixedThreadPool(4); }',
      filePath: 'A.java',
    });
    assert.ok(result.stats.estimated_tokens < 4000, `payload too large: ${result.stats.estimated_tokens}`);
  });
});
