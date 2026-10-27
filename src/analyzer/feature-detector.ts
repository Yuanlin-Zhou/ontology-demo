/**
 * Derives semantic features (01-phase1 §5) from the structured thread pool
 * model. Every feature carries evidence (line/column/snippet) and attributes,
 * so that the retrieval result can be explained and audited.
 */
import { compareFeatures, describeFeature } from '../domain/features.ts';
import type { AnalyzedFeature, Confidence, Evidence, FeatureHit } from '../domain/types.ts';
import type { JavaThreadPoolModel, PoolCreationFact } from './model.ts';

const RISKY_FACTORIES: readonly string[] = [
  'newFixedThreadPool',
  'newSingleThreadExecutor',
  'newCachedThreadPool',
  'newScheduledThreadPool',
  'newSingleThreadScheduledExecutor',
];

function defaultEvidence(): Evidence {
  return { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, snippet: '' };
}

function hit(
  feature: string,
  evidence: Evidence,
  nodeType: string,
  attributes: Record<string, string | number | boolean>,
  confidence: Confidence = 'high',
): FeatureHit {
  return { feature, ...evidence, nodeType, confidence, attributes };
}

function poolAttributes(pool: PoolCreationFact): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = { kind: pool.kind, scope: pool.scope };
  if (pool.factoryMethod !== undefined) attributes.factory = pool.factoryMethod;
  return attributes;
}

function poolHits(pool: PoolCreationFact): FeatureHit[] {
  const hits: FeatureHit[] = [];
  const attributes = poolAttributes(pool);
  hits.push(hit('THREAD_POOL.CREATE', pool.evidence, pool.node.type, attributes));
  if (pool.kind === 'executors_factory' && RISKY_FACTORIES.includes(pool.factoryMethod ?? '')) {
    hits.push(hit('THREAD_POOL.CREATE.EXECUTORS_FACTORY', pool.evidence, pool.node.type, attributes));
  }
  if (pool.kind === 'virtual_thread_executor') {
    hits.push(hit('VIRTUAL_THREAD', pool.evidence, pool.node.type, attributes));
  }
  if (pool.isScheduled) {
    hits.push(hit('THREAD_POOL.SCHEDULED', pool.evidence, pool.node.type, attributes));
  }
  if (pool.scope === 'local' || pool.scope === 'expression') {
    hits.push(hit('THREAD_POOL.CREATE.PER_REQUEST', pool.evidence, pool.node.type, attributes, pool.scope === 'expression' ? 'medium' : 'low'));
  }
  if (pool.coreSize !== undefined) {
    hits.push(hit('THREAD_POOL.CONFIG.CORE_SIZE', pool.evidence, pool.node.type, { value: pool.coreSize.text }));
  }
  if (pool.maxSize !== undefined) {
    hits.push(hit('THREAD_POOL.CONFIG.MAX_SIZE', pool.evidence, pool.node.type, { value: pool.maxSize.text }));
  }
  if (pool.keepAlive !== undefined) {
    hits.push(hit('THREAD_POOL.CONFIG.KEEP_ALIVE', pool.evidence, pool.node.type, { value: pool.keepAlive.text, unit: pool.timeUnit ?? '' }));
  }
  if (pool.queue !== undefined) {
    hits.push(
      hit('THREAD_POOL.CONFIG.QUEUE', pool.queue.evidence, pool.node.type, {
        queue: pool.queue.typeName,
        bounded: pool.queue.bounded,
        capacity: pool.queue.capacityText ?? 'unset',
      }),
    );
  } else if (pool.isScheduled) {
    hits.push(hit('THREAD_POOL.CONFIG.QUEUE', pool.evidence, pool.node.type, { queue: 'DelayedWorkQueue', bounded: false, implicit: true }, 'medium'));
  }
  if (pool.rejection !== undefined) {
    hits.push(hit('THREAD_POOL.CONFIG.REJECTION', pool.rejection.evidence, pool.node.type, { policy: pool.rejection.typeName, kind: pool.rejection.kind }));
  }
  if (pool.threadFactory !== undefined) {
    hits.push(hit('THREAD_POOL.CONFIG.THREAD_FACTORY', pool.threadFactory.evidence, pool.node.type, { factory: pool.threadFactory.typeName }));
  }
  if (pool.isBean) {
    hits.push(hit('SPRING.EXECUTOR_BEAN', pool.evidence, pool.node.type, attributes));
  }
  return hits;
}
/** Extracts all semantic features of a Java file model. */
export function detectFeatures(model: JavaThreadPoolModel): FeatureHit[] {
  const hits: FeatureHit[] = [];

  for (const pool of model.pools) hits.push(...poolHits(pool));

  for (const submit of model.submits) {
    const attributes: Record<string, string | number | boolean> = {
      method: submit.method,
      receiver: submit.receiver,
      resolution: submit.receiverResolution,
      result_used: submit.resultUsed,
    };
    const confidence: Confidence = submit.receiverResolution === 'unresolved' ? 'low' : submit.receiverResolution === 'heuristic' ? 'medium' : 'high';
    hits.push(hit('THREAD_POOL.SUBMIT', submit.evidence, submit.node.type, attributes, confidence));
    if (submit.method === 'execute') {
      hits.push(hit('THREAD_POOL.EXECUTE', submit.evidence, submit.node.type, attributes, confidence));
    }
    if (submit.method.startsWith('schedule')) {
      hits.push(hit('THREAD_POOL.SCHEDULED', submit.evidence, submit.node.type, attributes, confidence));
    }
    if (submit.taskThrows) {
      hits.push(hit('THREAD_POOL.EXCEPTION', submit.evidence, submit.node.type, { ...attributes, reason: 'task_throws' }, confidence));
    }
    if (submit.insideTry) {
      hits.push(hit('THREAD_POOL.EXCEPTION', submit.evidence, submit.node.type, { ...attributes, reason: 'call_in_try' }, confidence));
    }
  }

  if (model.hasUncaughtExceptionHandler) {
    hits.push(hit('THREAD_POOL.EXCEPTION.UNCAUGHT_HANDLER', model.submits[0]?.evidence ?? defaultEvidence(), 'method_invocation', {}));
  }

  for (const shutdown of model.shutdowns) {
    const attributes: Record<string, string | number | boolean> = { method: shutdown.method, receiver: shutdown.receiver };
    switch (shutdown.method) {
      case 'shutdown':
      case 'close':
        hits.push(hit('THREAD_POOL.SHUTDOWN', shutdown.evidence, shutdown.node.type, attributes));
        break;
      case 'shutdownNow':
        hits.push(hit('THREAD_POOL.SHUTDOWN_NOW', shutdown.evidence, shutdown.node.type, attributes));
        break;
      case 'awaitTermination':
        hits.push(hit('THREAD_POOL.AWAIT_TERMINATION', shutdown.evidence, shutdown.node.type, { ...attributes, timeout_args: shutdown.argCount }));
        break;
      default:
        break;
    }
  }

  for (const futureGet of model.futureGets) {
    hits.push(hit('THREAD_POOL.FUTURE.GET', futureGet.evidence, 'method_invocation', { receiver: futureGet.receiver, timeout: futureGet.hasTimeout }));
  }

  for (const async of model.asyncs) {
    if (async.kind === 'completable_future') {
      hits.push(hit('THREAD_POOL.COMPLETABLE_FUTURE', async.evidence, 'method_invocation', { method: async.method, asynchronous: async.asynchronous ?? true, explicit_executor: async.hasExplicitExecutor }));
    } else {
      hits.push(hit('VIRTUAL_THREAD', async.evidence, 'method_invocation', { method: async.method }));
    }
  }

  for (const threadLocal of model.threadLocals) {
    hits.push(
      hit('THREAD_POOL.THREAD_LOCAL', threadLocal.evidence, 'method_invocation', {
        kind: threadLocal.kind,
        name: threadLocal.name,
        in_finally: threadLocal.inFinally,
      }),
    );
  }

  for (const monitor of model.monitors) {
    hits.push(hit('THREAD_POOL.MONITOR', monitor.evidence, 'method_invocation', { method: monitor.method, receiver: monitor.receiver }));
  }

  for (const impl of model.customImpls) {
    if (impl.kind === 'thread_factory') {
      hits.push(hit('THREAD_POOL.THREAD_FACTORY.CUSTOM_IMPL', impl.evidence, 'class_declaration', { class: impl.className, sets_name: impl.hasSetName }));
    } else {
      hits.push(hit('THREAD_POOL.REJECTION.CUSTOM_IMPL', impl.evidence, 'class_declaration', { class: impl.className, reports: impl.hasReporting }));
    }
  }

  if (model.annotations.includes('Async')) {
    hits.push(hit('SPRING.ASYNC', model.submits[0]?.evidence ?? defaultEvidence(), 'marker_annotation', {}));
  }
  if (model.hasPreDestroy) {
    hits.push(hit('SPRING.PRE_DESTROY', model.pools[0]?.evidence ?? defaultEvidence(), 'marker_annotation', {}));
  }

  return hits.sort((a, b) => a.startLine - b.startLine || compareFeatures(a.feature, b.feature));
}
/** Groups raw hits into the summary returned by `retrieve`. */
export function summarizeFeatures(hits: FeatureHit[]): AnalyzedFeature[] {
  const grouped = new Map<string, FeatureHit[]>();
  for (const item of hits) {
    const list = grouped.get(item.feature);
    if (list === undefined) grouped.set(item.feature, [item]);
    else list.push(item);
  }
  const summary: AnalyzedFeature[] = [];
  for (const [id, list] of grouped) {
    const confidence: Confidence = list.some((item) => item.confidence === 'high')
      ? 'high'
      : list.some((item) => item.confidence === 'medium')
        ? 'medium'
        : 'low';
    const evidence: Evidence[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const key = `${item.startLine}:${item.startColumn}`;
      if (seen.has(key) || evidence.length >= 5) continue;
      seen.add(key);
      const entry: Evidence = {
        startLine: item.startLine,
        startColumn: item.startColumn,
        endLine: item.endLine,
        endColumn: item.endColumn,
        snippet: item.snippet,
      };
      if (item.symbol !== undefined) entry.symbol = item.symbol;
      evidence.push(entry);
    }
    summary.push({ id, description: describeFeature(id), hits: list.length, confidence, evidence });
  }
  return summary.sort((a, b) => compareFeatures(a.id, b.id));
}

/** Ordered list of the feature ids detected in a file. */
export function featureIdsOf(hits: FeatureHit[]): string[] {
  return [...new Set(hits.map((item) => item.feature))].sort(compareFeatures);
}
