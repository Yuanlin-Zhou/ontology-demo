/**
 * Semantic Feature catalog (01-phase1-rule-engine-poc.md §5).
 *
 * The first eight entries are the features required by the PoC scope; the rest
 * were added because the rule set needs them to express applicability
 * precisely (every one of them is grounded in the knowledge documents
 * `java-thread-pool-summary.md` / `java-thread-pool-best-practices.md`).
 */
import type { FeatureId } from './types.ts';

export interface FeatureDefinition {
  id: FeatureId;
  group: string;
  description: string;
}

export const FEATURE_CATALOG: readonly FeatureDefinition[] = [
  { id: 'THREAD_POOL.CREATE', group: 'create', description: '创建线程池（ThreadPoolExecutor / 容器托管线程池）' },
  { id: 'THREAD_POOL.CREATE.EXECUTORS_FACTORY', group: 'create', description: '使用 Executors 快捷工厂创建线程池' },
  { id: 'THREAD_POOL.CREATE.PER_REQUEST', group: 'create', description: '在方法或请求内临时创建线程池' },
  { id: 'THREAD_POOL.CONFIG.CORE_SIZE', group: 'config', description: '配置核心线程数 corePoolSize' },
  { id: 'THREAD_POOL.CONFIG.MAX_SIZE', group: 'config', description: '配置最大线程数 maximumPoolSize' },
  { id: 'THREAD_POOL.CONFIG.KEEP_ALIVE', group: 'config', description: '配置空闲存活时间 keepAliveTime' },
  { id: 'THREAD_POOL.CONFIG.QUEUE', group: 'config', description: '配置任务队列（阻塞队列类型与容量）' },
  { id: 'THREAD_POOL.CONFIG.REJECTION', group: 'config', description: '配置拒绝策略' },
  { id: 'THREAD_POOL.CONFIG.THREAD_FACTORY', group: 'config', description: '配置线程工厂' },
  { id: 'THREAD_POOL.SUBMIT', group: 'submit', description: '提交任务（submit / execute / invokeAll 等）' },
  { id: 'THREAD_POOL.EXECUTE', group: 'submit', description: '使用 execute 提交无返回值任务' },
  { id: 'THREAD_POOL.EXCEPTION', group: 'exception', description: '任务执行与提交的异常处理结构' },
  { id: 'THREAD_POOL.EXCEPTION.UNCAUGHT_HANDLER', group: 'exception', description: '设置线程未捕获异常处理器' },
  { id: 'THREAD_POOL.SHUTDOWN', group: 'shutdown', description: '关闭线程池（shutdown / close）' },
  { id: 'THREAD_POOL.SHUTDOWN_NOW', group: 'shutdown', description: '强制关闭线程池 shutdownNow' },
  { id: 'THREAD_POOL.AWAIT_TERMINATION', group: 'shutdown', description: '等待线程池终止 awaitTermination' },
  { id: 'THREAD_POOL.FUTURE.GET', group: 'submit', description: '调用 Future.get 获取任务结果' },
  { id: 'THREAD_POOL.COMPLETABLE_FUTURE', group: 'submit', description: '使用 CompletableFuture 编排异步任务' },
  { id: 'THREAD_POOL.THREAD_LOCAL', group: 'threadlocal', description: '使用 ThreadLocal / MDC 等线程上下文' },
  { id: 'THREAD_POOL.MONITOR', group: 'monitor', description: '读取线程池监控指标（队列长度、活跃线程数等）' },
  { id: 'THREAD_POOL.SCHEDULED', group: 'scheduled', description: '使用定时/延迟线程池' },
  { id: 'THREAD_POOL.THREAD_FACTORY.CUSTOM_IMPL', group: 'config', description: '自定义 ThreadFactory 实现' },
  { id: 'THREAD_POOL.REJECTION.CUSTOM_IMPL', group: 'config', description: '自定义 RejectedExecutionHandler 实现' },
  { id: 'SPRING.ASYNC', group: 'spring', description: '使用 Spring @Async 异步方法' },
  { id: 'SPRING.EXECUTOR_BEAN', group: 'spring', description: '以 @Bean / 容器托管方式暴露线程池' },
  { id: 'SPRING.PRE_DESTROY', group: 'spring', description: '使用 @PreDestroy 管理线程池生命周期' },
  { id: 'VIRTUAL_THREAD', group: 'virtual_thread', description: '使用虚拟线程' },
];

const BY_ID = new Map<FeatureId, FeatureDefinition>(FEATURE_CATALOG.map((f) => [f.id, f]));

/** All feature ids in catalog order (used for stable output ordering). */
export const FEATURE_IDS: FeatureId[] = FEATURE_CATALOG.map((f) => f.id);

const CATALOG_INDEX = new Map<FeatureId, number>(FEATURE_IDS.map((id, index) => [id, index]));

export function featureDefinition(id: FeatureId): FeatureDefinition | undefined {
  return BY_ID.get(id);
}

export function describeFeature(id: FeatureId): string {
  return BY_ID.get(id)?.description ?? id;
}

export function featureGroup(id: FeatureId): string {
  return BY_ID.get(id)?.group ?? 'unknown';
}

/** Sorts feature ids in catalog order; unknown ids go last (alphabetically). */
export function compareFeatures(a: FeatureId, b: FeatureId): number {
  const ai = CATALOG_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
  const bi = CATALOG_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.localeCompare(b);
}

/** Feature prefixes of the PoC scope: rules outside these prefixes are rejected. */
export const KNOWN_FEATURE_PREFIXES: readonly string[] = [
  'THREAD_POOL.',
  'SPRING.',
  'VIRTUAL_THREAD',
];
