/**
 * Deterministic checkers for the thread pool rule set.
 *
 * Each checker is registered by name and referenced from the rule YAML via
 * `check.validator`. Checkers are intentionally simple and conservative: they
 * only report what can be proven from the AST model (no data-flow analysis).
 */
import type { JavaSyntaxNode } from '../../analyzer/java-parser.ts';
import { childForField, methodNameOf, receiverName, receiverOf, walk } from '../../analyzer/ast-utils.ts';
import {
  INTEGER_MAX_VALUE,
  applicationPools,
  numberParam,
  poolFinding,
  poolLabel,
  registerValidator,
  type CheckContext,
  type CheckFinding,
} from '../validator-registry.ts';

const RISKY_FACTORY_PATTERN = /^new(FixedThreadPool|SingleThreadExecutor|CachedThreadPool|ScheduledThreadPool|SingleThreadScheduledExecutor|WorkStealingPool)$/;

function riskOfFactory(factory: string): string {
  switch (factory) {
    case 'newCachedThreadPool':
      return '内部使用 SynchronousQueue 且最大线程数为 Integer.MAX_VALUE，提交速度长期高于处理速度时会不断创建线程';
    case 'newScheduledThreadPool':
    case 'newSingleThreadScheduledExecutor':
      return '内部使用无界 DelayedWorkQueue，延迟任务会持续堆积';
    default:
      return '内部使用无界 LinkedBlockingQueue（容量 Integer.MAX_VALUE），任务会持续堆积直至 OOM';
  }
}

/** TP-CREATE-001: 显式创建线程池。 */
registerValidator('thread_pool.no_executors_factory', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    if (pool.kind !== 'executors_factory') continue;
    const factory = pool.factoryMethod ?? '';
    if (!RISKY_FACTORY_PATTERN.test(factory)) continue;
    findings.push(
      poolFinding(
        pool,
        `Executors.${factory}(...) 隐藏了队列与拒绝策略：${riskOfFactory(factory)}。`,
        '改为 new ThreadPoolExecutor(corePoolSize, maximumPoolSize, keepAliveTime, unit, new ArrayBlockingQueue<>(capacity), threadFactory, rejectionHandler)，把线程数、队列容量、命名工厂和拒绝策略显式写出。',
      ),
    );
  }
  return findings;
});

/** TP-CREATE-002: 不要重复创建线程池。 */
registerValidator('thread_pool.no_inline_pool_creation', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    if (pool.scope !== 'local' && pool.scope !== 'expression') continue;
    findings.push(
      poolFinding(
        pool,
        `线程池在方法内部创建（${poolLabel(pool)}），每次调用都会新建一套线程与队列。`,
        '把线程池提升为字段或容器 Bean 创建一次，方法内只提交任务；确需独立资源时也要保证生命周期受控。',
      ),
    );
  }
  return findings;
});

/** TP-CREATE-003: 线程池必须配置线程工厂。 */
registerValidator('thread_pool.thread_factory_present', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    if (pool.kind === 'spring_task_executor' || pool.kind === 'virtual_thread_executor') continue;
    if (pool.threadFactory !== undefined) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 没有指定 ThreadFactory，工作线程会使用 pool-N-thread-M 这类默认名称。`,
        '传入命名线程工厂（如 namedFactory("order-notify")），或使用 ThreadPoolTaskExecutor#setThreadNamePrefix。',
      ),
    );
  }
  return findings;
});

/** TP-CREATE-004: 自定义线程工厂必须设置线程名。 */
registerValidator('thread_pool.thread_factory_named', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const impl of ctx.model.customImpls) {
    if (impl.kind !== 'thread_factory' || impl.hasSetName) continue;
    findings.push({
      message: `ThreadFactory 实现 ${impl.className} 的 newThread 中没有调用 Thread#setName。`,
      suggestion: '在 newThread 中设置线程名，例如 thread.setName(prefix + "-" + sequence.incrementAndGet())。',
      line: impl.evidence.startLine,
      column: impl.evidence.startColumn,
      snippet: impl.evidence.snippet,
      symbol: impl.className,
    });
  }
  for (const pool of ctx.model.pools) {
    if (pool.threadFactory?.setsName !== false) continue;
    findings.push(
      poolFinding(pool, `线程工厂 ${pool.threadFactory.typeName} 没有设置线程名。`, '在线程工厂中设置线程名，便于日志与线程转储定位。'),
    );
  }
  return findings;
});

/** TP-CREATE-005: 交给容器管理线程池生命周期。 */
registerValidator('thread_pool.pool_lifecycle_managed', (ctx: CheckContext): CheckFinding[] => {
  const beanPools = applicationPools(ctx.model).filter((pool) => pool.isBean);
  if (beanPools.length === 0) return [];
  // `ThreadPoolTaskExecutor` implements DisposableBean: the container closes it.
  if (beanPools.every((pool) => pool.kind === 'spring_task_executor')) return [];
  if (ctx.model.hasPreDestroy) return [];
  const pool = beanPools[0];
  if (pool === undefined) return [];
  return [
    poolFinding(
      pool,
      '线程池通过容器托管，但本文件没有 @PreDestroy 关闭逻辑。',
      '增加 @PreDestroy 方法调用 shutdown()/awaitTermination()，或实现 DisposableBean，确保应用关闭时线程池被回收。',
    ),
  ];
});

/** TP-CONFIG-001: 核心线程数必须显式配置且大于 0。 */
registerValidator('thread_pool.core_size_explicit', (ctx: CheckContext): CheckFinding[] => {
  const min = numberParam(ctx.params, 'min', 1);
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const core = pool.coreSize;
    if (core === undefined) continue;
    if (core.text === 'unset') {
      findings.push(
        poolFinding(pool, `${poolLabel(pool)} 的核心线程数没有写出来。`, `显式写出 corePoolSize（至少 ${min}），并结合高峰提交速率与任务耗时估算。`),
      );
      continue;
    }
    if (core.number !== undefined && core.number < min) {
      findings.push(
        poolFinding(
          pool,
          `${poolLabel(pool)} 的 corePoolSize = ${core.number}，无法保证常驻工作线程。`,
          `把 corePoolSize 设置为经压测验证的正数（当前约束 min=${min}），并在配置中显式写出。`,
        ),
      );
    }
  }
  return findings;
});

/** TP-CONFIG-002: 最大线程数必须有界。 */
registerValidator('thread_pool.max_size_bounded', (ctx: CheckContext): CheckFinding[] => {
  const max = numberParam(ctx.params, 'max', 100000);
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const maximum = pool.maxSize;
    if (maximum === undefined) continue;
    if (maximum.number === undefined) continue;
    if (maximum.number < Math.min(max, INTEGER_MAX_VALUE)) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 的 maximumPoolSize = ${maximum.text}，线程数没有实际上界。`,
        `设置明确的上界（当前约束 max=${max}），并同时考虑 CPU、内存、数据库连接池与下游限流。`,
      ),
    );
  }
  return findings;
});

/** TP-CONFIG-003: keepAliveTime 必须与核心/最大线程数匹配。 */
registerValidator('thread_pool.keep_alive_positive', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const core = pool.coreSize?.number;
    const max = pool.maxSize?.number;
    const keepAlive = pool.keepAlive;
    if (core === undefined || max === undefined || core >= max) continue;
    if (keepAlive === undefined || keepAlive.number === undefined || keepAlive.number > 0) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 的 maximumPoolSize(${max}) 大于 corePoolSize(${core})，但 keepAliveTime = ${keepAlive.text}。`,
        '给超出核心数的线程设置正的空闲存活时间，例如 60L + TimeUnit.SECONDS；需要回收核心线程时再开启 allowCoreThreadTimeOut(true)。',
      ),
    );
  }
  return findings;
});

/** TP-CONFIG-004: 任务队列必须有界。 */
registerValidator('thread_pool.queue_bounded', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const queue = pool.queue;
    if (queue === undefined || queue.bounded) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 使用了无界队列 ${queue.typeName}：${queue.reason}。`,
        '改用 new ArrayBlockingQueue<>(capacity) 并显式给出容量（可参照 Q ≈ (λ_in − λ_out) × Δt 估算），同时配置拒绝策略。',
        queue.typeName,
      ),
    );
  }
  return findings;
});

/** TP-CONFIG-005: 队列容量必须可控。 */
registerValidator('thread_pool.queue_capacity_bounded', (ctx: CheckContext): CheckFinding[] => {
  const maxCapacity = numberParam(ctx.params, 'maxCapacity', 10000);
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const queue = pool.queue;
    if (queue === undefined) continue;
    if (queue.typeName === 'SynchronousQueue') continue;
    if (queue.capacity === undefined && queue.capacityText === undefined) continue;
    if (queue.capacity === undefined) continue;
    if (queue.capacity <= maxCapacity) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 的队列容量 = ${queue.capacityText ?? queue.capacity}，超过约定上限 ${maxCapacity}，任务可能在执行前就已超过业务超时时间。`,
        `把队列容量收敛到 ${maxCapacity} 以内（按突发流量与内存上限估算），并用拒绝策略处理溢出任务。`,
        queue.typeName,
      ),
    );
  }
  return findings;
});

/** TP-CONFIG-006: 禁止 DiscardOldestPolicy 与优先级队列组合。 */
registerValidator('thread_pool.no_discard_oldest_with_priority_queue', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const queue = pool.queue;
    const rejection = pool.rejection;
    if (queue === undefined || rejection === undefined) continue;
    if (rejection.kind !== 'discard_oldest') continue;
    if (!/Priority/.test(queue.typeName)) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 把 DiscardOldestPolicy 与 ${queue.typeName} 组合使用：poll() 丢弃的将是优先级最高的任务。`,
        '改为 AbortPolicy + 调用侧补偿，或自定义拒绝策略显式选择要丢弃的任务。',
        queue.typeName,
      ),
    );
  }
  return findings;
});

/* ------------------------------------------------------------------ *
 * 任务提交与异常处理
 * ------------------------------------------------------------------ */

function submitLabel(receiver: string, method: string): string {
  return receiver.length > 0 ? `${receiver}.${method}(...)` : `${method}(...)`;
}

/** TP-SUBMIT-001: submit 返回的 Future 必须被处理。 */
registerValidator('thread_pool.future_result_handled', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const submit of ctx.model.submits) {
    if (submit.method !== 'submit' || submit.resultUsed) continue;
    findings.push({
      message: `${submitLabel(submit.receiver, submit.method)} 的返回值被丢弃，任务异常会一直保存在 Future 中而不被感知。`,
      suggestion: '处理返回的 Future：get(3, TimeUnit.SECONDS) 并捕获 ExecutionException/TimeoutException，或链接 whenComplete/thenAccept 回调。',
      line: submit.evidence.startLine,
      column: submit.evidence.startColumn,
      snippet: submit.evidence.snippet,
    });
  }
  return findings;
});

/** TP-SUBMIT-002: Future.get 必须带超时。 */
registerValidator('thread_pool.future_get_with_timeout', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const get of ctx.model.futureGets) {
    if (get.hasTimeout) continue;
    findings.push({
      message: `${get.receiver}.get() 没有超时参数，任务卡住时会一直阻塞调用线程。`,
      suggestion: '使用 get(timeout, unit)（例如 get(3, TimeUnit.SECONDS)）并处理 TimeoutException；CompletableFuture 可用 orTimeout/completeOnTimeout。',
      line: get.evidence.startLine,
      column: get.evidence.startColumn,
      snippet: get.evidence.snippet,
    });
  }
  return findings;
});

/** TP-SUBMIT-003: CompletableFuture 异步方法必须指定 Executor。 */
registerValidator('thread_pool.completable_future_executor', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const async of ctx.model.asyncs) {
    if (async.kind !== 'completable_future' || async.hasExplicitExecutor) continue;
    findings.push({
      message: `CompletableFuture.${async.method} 没有指定 Executor，会使用公共 ForkJoinPool，阻塞任务会影响应用内其它异步任务。`,
      suggestion: '显式传入业务线程池：CompletableFuture.supplyAsync(supplier, orderExecutor)，并为该线程池配置命名线程、有界队列与拒绝策略。',
      line: async.evidence.startLine,
      column: async.evidence.startColumn,
      snippet: async.evidence.snippet,
    });
  }
  return findings;
});

/** Method declarations of the file, keyed by method name (1-level inter-procedural helper). */
function methodDeclarations(root: JavaSyntaxNode): Map<string, JavaSyntaxNode> {
  const map = new Map<string, JavaSyntaxNode>();
  walk(root, (node) => {
    if (node.type !== 'method_declaration') return;
    const name = childForField(node, 'name')?.text;
    if (name !== undefined && name !== null && name.length > 0) map.set(name, node);
  });
  return map;
}

function calledMethodNamesIn(node: JavaSyntaxNode): string[] {
  const names: string[] = [];
  walk(node, (current) => {
    if (current.type === 'method_invocation') names.push(methodNameOf(current));
  });
  return names;
}

function invokesRemoveOn(node: JavaSyntaxNode, threadLocalName: string): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type !== 'method_invocation') return;
    if (methodNameOf(current) !== 'remove') return;
    if (receiverName(receiverOf(current)) === threadLocalName) found = true;
  });
  return found;
}

/**
 * True when a `finally` block of the file delegates the cleanup to a method
 * declared in the same file (e.g. `finally { TenantContext.restore(previous); }`).
 * Only one level of indirection is resolved; deeper call chains are reported as
 * violations (documented limitation, no data-flow analysis in Phase 1).
 */
function cleanedInFinallyThroughHelper(ctx: CheckContext, threadLocalName: string): boolean {
  const methods = methodDeclarations(ctx.parsed.rootNode);
  if (methods.size === 0) return false;
  let cleaned = false;
  walk(ctx.parsed.rootNode, (node) => {
    if (node.type !== 'finally_clause') return;
    for (const called of calledMethodNamesIn(node)) {
      const method = methods.get(called);
      if (method === undefined) continue;
      if (invokesRemoveOn(method, threadLocalName)) cleaned = true;
    }
  });
  return cleaned;
}

/** TP-SUBMIT-004: ThreadLocal 必须在 finally 中清理。 */
registerValidator('thread_pool.thread_local_cleanup', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  const setHits = ctx.model.threadLocals.filter((item) => item.kind === 'set');
  const removeHits = ctx.model.threadLocals.filter((item) => item.kind === 'remove');
  for (const name of [...new Set(setHits.map((item) => item.name))]) {
    const removes = removeHits.filter((item) => item.name === name);
    if (removes.some((item) => item.inFinally) || cleanedInFinallyThroughHelper(ctx, name)) continue;
    const hit = setHits.find((item) => item.name === name);
    if (hit === undefined) continue;
    const message =
      removes.length === 0
        ? `${name} 在任务中被写入，但没有在 finally 中 remove/恢复：线程被复用时会读到上一个任务的值。`
        : `${name} 有清理调用，但不在 finally 中，异常路径下仍然会残留线程上下文。`;
    findings.push({
      message,
      suggestion: '在任务外包一层 try/finally，在 finally 中 remove() 或恢复原值（日志 MDC、租户、登录信息都要处理），跨线程传递场景使用统一的任务包装器。',
      line: hit.evidence.startLine,
      column: hit.evidence.startColumn,
      snippet: hit.evidence.snippet,
      symbol: name,
    });
  }
  return findings;
});

/** TP-SUBMIT-005: 任务内异常必须被处理。 */
registerValidator('thread_pool.task_exception_handled', (ctx: CheckContext): CheckFinding[] => {
  if (ctx.model.hasUncaughtExceptionHandler) return [];
  const findings: CheckFinding[] = [];
  for (const submit of ctx.model.submits) {
    if (submit.method !== 'execute') continue;
    if (submit.insideTry) continue;
    if (!submit.taskThrows) continue;
    findings.push({
      message: `${submitLabel(submit.receiver, submit.method)} 提交的任务会抛异常，且没有 try/catch 或未捕获异常处理器。`,
      suggestion: '在任务体内 try/catch 并记录日志（必要时做补偿），或为线程池设置 setUncaughtExceptionHandler 统一上报。',
      line: submit.evidence.startLine,
      column: submit.evidence.startColumn,
      snippet: submit.evidence.snippet,
    });
  }
  return findings;
});


/* ------------------------------------------------------------------ *
 * 拒绝策略
 * ------------------------------------------------------------------ */

/** TP-REJECT-001: 必须显式配置拒绝策略。 */
registerValidator('thread_pool.rejection_explicit', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    if (pool.kind === 'executors_factory' || pool.kind === 'virtual_thread_executor') continue;
    if (pool.rejection !== undefined) continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 没有显式配置拒绝策略，队列满时会使用默认 AbortPolicy 直接抛 RejectedExecutionException。`,
        '显式传入第 7 个参数或调用 setRejectedExecutionHandler：核心业务用 AbortPolicy 并做调用侧补偿，允许反压的场景用 CallerRunsPolicy。',
      ),
    );
  }
  return findings;
});

/** TP-REJECT-002: 禁止静默丢弃任务。 */
registerValidator('thread_pool.no_silent_discard', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const rejection = pool.rejection;
    if (rejection === undefined || rejection.kind !== 'discard') continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 使用 DiscardPolicy，被拒绝的任务会被静默丢弃且没有任何痕迹。`,
        '改用 AbortPolicy + 调用侧补偿（重试/落盘），或自定义拒绝策略记录日志并上报拒绝计数。',
        rejection.typeName,
      ),
    );
  }
  return findings;
});

function abortsOnSaturation(ctx: CheckContext): boolean {
  return ctx.model.pools.some((pool) => pool.rejection === undefined || pool.rejection.kind === 'abort');
}

function catchesRejection(submit: { insideTry: boolean; caughtTypes: readonly string[] }): boolean {
  if (!submit.insideTry) return false;
  return submit.caughtTypes.some((type) => ['RejectedExecutionException', 'RuntimeException', 'Exception', 'Throwable'].includes(type));
}

/** TP-REJECT-003: 必须处理 RejectedExecutionException。 */
registerValidator('thread_pool.reject_exception_caught', (ctx: CheckContext): CheckFinding[] => {
  if (!abortsOnSaturation(ctx)) return [];
  const findings: CheckFinding[] = [];
  for (const submit of ctx.model.submits) {
    if (catchesRejection(submit)) continue;
    if (submit.receiverResolution === 'unresolved') continue;
    findings.push({
      message: `${submitLabel(submit.receiver, submit.method)} 在 AbortPolicy（或默认策略）下可能抛出 RejectedExecutionException，但调用处没有捕获处理。`,
      suggestion: '用 try/catch 包住提交调用并做补偿：重试、持久化后补偿、降级返回业务错误码，并记录拒绝日志与监控计数。',
      line: submit.evidence.startLine,
      column: submit.evidence.startColumn,
      snippet: submit.evidence.snippet,
    });
  }
  return findings;
});

/** TP-REJECT-004: CallerRunsPolicy 需要评估调用线程。 */
registerValidator('thread_pool.caller_runs_reviewed', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const pool of ctx.model.pools) {
    const rejection = pool.rejection;
    if (rejection === undefined || rejection.kind !== 'caller_runs') continue;
    findings.push(
      poolFinding(
        pool,
        `${poolLabel(pool)} 使用 CallerRunsPolicy：过载时任务会在调用者线程中执行，需要确认调用线程（可能是 Web 请求线程）能承受这段耗时。`,
        '确认调用链可以接受同步执行（后台批处理/反压场景），否则改用 AbortPolicy + 降级，或把溢出任务转入独立的补偿通道。',
        rejection.typeName,
      ),
    );
  }
  return findings;
});

/* ------------------------------------------------------------------ *
 * 关闭与可观测性
 * ------------------------------------------------------------------ */

/** TP-SHUTDOWN-001: 应用级线程池必须有确定的关闭逻辑。 */
registerValidator('thread_pool.shutdown_present', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  const shutdownTargets = new Set(ctx.model.shutdowns.map((shutdown) => shutdown.receiver));
  for (const pool of applicationPools(ctx.model)) {
    if (pool.kind === 'spring_task_executor') continue;
    if (pool.variableName === undefined) continue;
    if (shutdownTargets.has(pool.variableName)) continue;
    findings.push(
      poolFinding(
        pool,
        `应用级线程池 ${pool.variableName} 在本文件内没有任何关闭调用（shutdown/close）。`,
        '在 @PreDestroy、应用关闭钩子或 close() 中调用 shutdown() + awaitTermination()，确保工作线程被回收、队列任务的处置明确。',
        pool.variableName,
      ),
    );
  }
  return findings;
});

/** TP-SHUTDOWN-002: 优雅关闭需等待终止。 */
registerValidator('thread_pool.graceful_shutdown', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  const awaitTargets = new Set(ctx.model.shutdowns.filter((s) => s.method === 'awaitTermination').map((s) => s.receiver));
  for (const shutdown of ctx.model.shutdowns) {
    if (shutdown.method !== 'shutdown' && shutdown.method !== 'close') continue;
    if (awaitTargets.has(shutdown.receiver)) continue;
    findings.push({
      message: `${shutdown.receiver}.${shutdown.method}() 之后没有 awaitTermination(timeout, unit)，无法确认任务是否执行完毕。`,
      suggestion: '关闭标准流程：shutdown() → awaitTermination(30, TimeUnit.SECONDS) → 超时后 shutdownNow() 兜底，并在 catch (InterruptedException) 中恢复中断状态。',
      line: shutdown.evidence.startLine,
      column: shutdown.evidence.startColumn,
      snippet: shutdown.evidence.snippet,
    });
  }
  return findings;
});

/** TP-SHUTDOWN-003: 捕获 InterruptedException 后必须恢复中断状态。 */
registerValidator('thread_pool.interrupt_restored', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const caught of ctx.model.interruptCatches) {
    if (caught.restored) continue;
    findings.push({
      message: `catch (InterruptedException) 中没有恢复中断状态，取消语义（shutdownNow / Future.cancel）会失效。`,
      suggestion: '在清理动作之后调用 Thread.currentThread().interrupt()，或把 InterruptedException 继续向上抛出。',
      line: caught.evidence.startLine,
      column: caught.evidence.startColumn,
      snippet: caught.evidence.snippet,
      symbol: caught.variableName,
    });
  }
  return findings;
});

/** TP-SHUTDOWN-004: shutdownNow 返回的未执行任务必须被处理。 */
registerValidator('thread_pool.shutdown_now_pending_tasks', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const shutdown of ctx.model.shutdowns) {
    if (shutdown.method !== 'shutdownNow' || shutdown.resultUsed) continue;
    findings.push({
      message: `${shutdown.receiver}.shutdownNow() 返回的未执行任务列表被丢弃，队列中的任务会静默丢失。`,
      suggestion: '接收返回值并处理：记录数量、写入补偿表/消息队列供重启后消费，或转入其它执行通道。',
      line: shutdown.evidence.startLine,
      column: shutdown.evidence.startColumn,
      snippet: shutdown.evidence.snippet,
    });
  }
  return findings;
});

/** TP-MONITOR-001: 线程池必须可观测。 */
registerValidator('thread_pool.pool_observable', (ctx: CheckContext): CheckFinding[] => {
  const pools = applicationPools(ctx.model);
  if (pools.length === 0) return [];
  if (ctx.model.monitors.length > 0) return [];
  const pool = pools[0];
  if (pool === undefined) return [];
  return [
    poolFinding(
      pool,
      `线程池 ${pool.variableName ?? poolLabel(pool)} 没有暴露任何监控指标（队列长度/活跃线程/完成数/拒绝次数）。`,
      '暴露 getQueue().size()、getActiveCount()、getCompletedTaskCount()、getTaskCount() 等指标并配置告警，拒绝次数要单独计数。',
      pool.variableName,
    ),
  ];
});

/** TP-REJECT-005: 自定义拒绝策略必须记录并上报。 */
registerValidator('thread_pool.custom_rejection_reported', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const impl of ctx.model.customImpls) {
    if (impl.kind !== 'rejection_handler' || impl.hasReporting) continue;
    findings.push({
      message: `自定义拒绝策略 ${impl.className} 没有记录日志或上报指标，拒绝事件不可观测。`,
      suggestion: '在 rejectedExecution 中记录被拒绝任务的关键信息并递增监控计数（日志 + 指标 + 需要时落盘补偿）。',
      line: impl.evidence.startLine,
      column: impl.evidence.startColumn,
      snippet: impl.evidence.snippet,
      symbol: impl.className,
    });
  }
  return findings;
});
