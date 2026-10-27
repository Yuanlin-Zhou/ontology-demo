/**
 * Deterministic checkers for the thread pool rule set.
 *
 * Each checker is registered by name and referenced from the rule YAML via
 * `check.validator`. Checkers are intentionally simple and conservative: they
 * only report what can be proven from the AST model (no data-flow analysis).
 */
import type { JavaSyntaxNode } from '../../analyzer/java-parser.ts';
import { JavaSymbols, enclosing, isWithin } from '../../analyzer/java-symbols.ts';
import { childForField, isInFinally, methodNameOf, receiverName, receiverOf, walk } from '../../analyzer/ast-utils.ts';
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

const RISKY_FACTORY_PATTERN = /^new(FixedThreadPool|SingleThreadExecutor|CachedThreadPool|ScheduledThreadPool|SingleThreadScheduledExecutor)$/;

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
    if (pool.kind === 'spring_task_executor' || pool.kind === 'virtual_thread_executor' || pool.factoryMethod === 'newWorkStealingPool') continue;
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
  return applicationPools(ctx.model).filter(pool => pool.isBean && !pool.containerManaged &&
    !ctx.model.shutdowns.some(s => s.poolId === pool.id && ['shutdown', 'shutdownNow', 'close'].includes(s.method))).map(pool =>
      poolFinding(pool, 'Bean 禁用了推断销毁且没有针对该池的关闭路径。',
        '保留 Spring 默认销毁推断、显式配置 destroyMethod，或为该池提供关闭回调；确保只有一个关闭责任方。', pool.variableName));
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
    if (submit.method !== 'submit' || submit.resultHandled) continue;
    findings.push({
      message: `${submitLabel(submit.receiver, submit.method)} 返回的 Future 未见消费或委托，任务异常可能一直保存在 Future 中而不被感知。`,
      suggestion: '普通 Future 使用 get(3, TimeUnit.SECONDS) 并处理 ExecutionException、TimeoutException 和中断；只有 CompletableFuture 支持 whenComplete 等回调。',
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
    if (async.kind !== 'completable_future' || async.asynchronous === false || async.hasExplicitExecutor) continue;
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

/** Check each write and one-hop private helper callers in their own execution boundary. */
registerValidator('thread_pool.thread_local_cleanup', (ctx: CheckContext): CheckFinding[] => {
  const symbols = new JavaSymbols(ctx.parsed.rootNode);
  const findings: CheckFinding[] = [];
  const callables = ['lambda_expression', 'method_declaration', 'constructor_declaration'];
  for (const write of ctx.model.threadLocals.filter(t => t.kind === 'set' && !t.inFinally)) {
    const owner = enclosing(write.node, callables);
    const matches = (expression: JavaSyntaxNode | null): boolean => write.name === 'MDC'
      ? receiverName(expression) === 'MDC' : expression !== null && symbols.lookup(expression)?.id === write.symbolId;
    const removes = (body: JavaSyntaxNode): boolean => {
      let found = false;
      walk(body, n => {
        if (n.type === 'method_invocation' && (methodNameOf(n) === 'remove' || (write.name === 'MDC' && methodNameOf(n) === 'clear')) && matches(receiverOf(n))) found = true;
      });
      return found;
    };
    const protectedAt = (site: JavaSyntaxNode, allowAdjacentWrite: boolean): boolean => {
      const execution = enclosing(site, callables);
      return symbols.nodes.filter(n => ['try_statement', 'try_with_resources_statement'].includes(n.type) &&
        enclosing(n, callables)?.id === execution?.id &&
        (isWithin(site, childForField(n, 'body') ?? n) ||
          (allowAdjacentWrite && n.parent?.id === site.parent?.parent?.id && n.startIndex > site.endIndex &&
            !n.parent?.namedChildren.some(s => s.startIndex > site.endIndex && s.endIndex < n.startIndex))))
        .some(attempt => {
          const final = attempt.namedChildren.find(n => n.type === 'finally_clause');
          if (!final) return false;
          if (removes(final)) return true;
          let cleaned = false;
          walk(final, n => {
            if (n.type !== 'method_invocation') return;
            const helper = symbols.method(n);
            if (helper && removes(helper)) cleaned = true;
          });
          return cleaned;
        });
    };
    const callers = owner?.type === 'method_declaration' ? symbols.nodes.filter(n => n.type === 'method_invocation' && symbols.method(n)?.id === owner.id) : [];
    // A restore helper used exclusively by finally is itself cleanup.
    if (callers.length && callers.every(isInFinally) && owner && removes(owner)) continue;
    if (protectedAt(write.node, true)) continue;
    const privateHelper = owner?.type === 'method_declaration' && /\bprivate\b/.test(owner.namedChildren.find(n => n.type === 'modifiers')?.text ?? '');
    if (privateHelper && callers.length && callers.every(c => protectedAt(c, false))) continue;
    const unprotected = privateHelper ? callers.filter(c => !protectedAt(c, false)) : [];
    const helperName = owner?.childForFieldName('name')?.text;
    const detail = unprotected.length ? ` 私有方法 ${helperName} 的调用 L${unprotected.map(c => c.startPosition.row + 1).join(', L')} 未位于对应 try/finally 的 try 内。` : '';
    findings.push({ message: `${write.name} 的本次写入没有对应的 finally 清理路径，复用线程可能残留上下文。${detail}`,
      suggestion: unprotected.length
        ? `将 ${helperName}(...) 的调用移入对应 try/finally 的 try 体内，并在 finally 内清理或恢复 ${write.name}；只在调用之后加 finally，不能保护 helper 本身抛异常的路径。`
        : '把本次任务包装在 try/finally 中，在对应 finally 内 remove() 或调用当前类的上下文恢复方法。',
      line: write.evidence.startLine, column: write.evidence.startColumn, snippet: write.evidence.snippet, symbol: write.name });
  }
  return findings;
});

/** TP-SUBMIT-005: 任务内异常必须被处理。 */
registerValidator('thread_pool.task_exception_handled', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const submit of ctx.model.submits) {
    if(['scheduleWithFixedDelay','scheduleAtFixedRate'].includes(submit.method)){
      if(!submit.periodicExceptionHandled)findings.push({
        message:`${submitLabel(submit.receiver,submit.method)} 未发现覆盖周期任务整体的异常保护；回调抛 RuntimeException 后可能停止全部后续执行。`,
        suggestion:'在实际运行的周期任务内用 try/catch(RuntimeException) 保护整个业务回调并记录失败，不向调度器重新抛出；提交外层 catch 和 Thread 的未捕获异常处理器不能维持周期。无法解析的 Runnable/方法引用需要另作源码或运行验收。',
        line:submit.evidence.startLine,column:submit.evidence.startColumn,snippet:submit.evidence.snippet,
      });
      continue;
    }
    if (submit.method !== 'execute') continue;
    if (!submit.taskThrows || submit.taskExceptionHandled) continue;
    const pool = ctx.model.pools.find(p => p.id === submit.poolId);
    if (pool?.threadFactory?.handlesExceptions) continue;
    findings.push({
      message: `${submitLabel(submit.receiver, submit.method)} 提交的任务会抛异常，且没有 try/catch 或未捕获异常处理器。`,
      suggestion: '在任务体内 try/catch 并记录日志（必要时做补偿），或通过 ThreadFactory 对新建的 Thread 调用 thread.setUncaughtExceptionHandler(handler)；ThreadPoolExecutor 没有该方法。',
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
    if (pool.kind === 'executors_factory' || pool.kind === 'virtual_thread_executor' || pool.kind === 'thread_per_task_executor') continue;
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


function catchesRejection(submit: { insideTry: boolean; caughtTypes: readonly string[] }): boolean {
  if (!submit.insideTry) return false;
  return submit.caughtTypes.some((type) => ['RejectedExecutionException', 'RuntimeException', 'Exception', 'Throwable'].includes(type));
}

/** TP-REJECT-003: 必须处理 RejectedExecutionException。 */
registerValidator('thread_pool.reject_exception_caught', (ctx: CheckContext): CheckFinding[] => {
  const findings: CheckFinding[] = [];
  for (const submit of ctx.model.submits) {
    const pool = ctx.model.pools.find(p => p.id === submit.poolId);
    if (pool && pool.rejection && pool.rejection.kind !== 'abort') continue;
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
  const shutdownTargets = new Set(ctx.model.shutdowns.filter(s => ['shutdown', 'shutdownNow', 'close'].includes(s.method)).map(s => s.poolId));
  for (const pool of applicationPools(ctx.model)) {
    if (pool.containerManaged) continue;
    if (shutdownTargets.has(pool.id)) continue;
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
  const symbols = new JavaSymbols(ctx.parsed.rootNode);
  const boundaries = ['method_declaration', 'constructor_declaration', 'lambda_expression'];

  for (const shutdown of ctx.model.shutdowns) {
    if (shutdown.method !== 'shutdown' && shutdown.method !== 'close') continue;
    // ExecutorService.close() (Java 21) waits for termination itself.
    if (shutdown.method === 'close') continue;
    const method = enclosing(shutdown.node, boundaries);
    const waits = ctx.model.shutdowns.filter(s => s.method === 'awaitTermination' &&
      (shutdown.poolId ? s.poolId === shutdown.poolId : s.receiver === shutdown.receiver) &&
      s.argCount === 2);
    if (waits.some(s => enclosing(s.node, boundaries)?.id === method?.id && s.node.startIndex > shutdown.node.startIndex)) continue;
    // One private, unambiguous, zero-argument helper; no virtual dispatch or parameter mapping.
    const delegatedWait = symbols.nodes.some(call => {
      if (call.type !== 'method_invocation' || call.startIndex < shutdown.node.endIndex ||
        enclosing(call, boundaries)?.id !== method?.id ||
        (childForField(call, 'arguments')?.namedChildren.length ?? 0) !== 0) return false;
      const helper = symbols.method(call);
      if (!helper || helper.id === method?.id ||
        !/\bprivate\b/.test(helper.namedChildren.find(n => n.type === 'modifiers')?.text ?? '') ||
        (childForField(helper, 'parameters')?.namedChildren.length ?? 0) !== 0) return false;
      return waits.some(s => enclosing(s.node, boundaries)?.id === helper.id);
    });
    if (delegatedWait) continue;
    const pool = ctx.model.pools.find(p => p.id === shutdown.poolId);
    if (pool?.kind === 'spring_task_executor' && pool.waitsForTasksOnShutdown && (pool.awaitTerminationSeconds ?? 0) > 0) continue;
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
      message: `未确认 catch (InterruptedException) 的所有已分析路径恢复当前线程中断状态或重抛原异常，取消语义可能丢失。`,
      suggestion: '在当前执行路径或对应 finally 中调用 Thread.currentThread().interrupt()，或继续抛出原 InterruptedException；不要只在延迟 lambda、其他线程或部分条件分支中恢复。复杂循环、嵌套 try 和跨方法恢复需另行审查。',
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
  return pools.filter(pool => !ctx.model.monitors.some(m => m.poolId === pool.id)).map(pool =>
    poolFinding(pool, `线程池 ${pool.variableName ?? poolLabel(pool)} 没有关联到可观察的运行指标。`,
      pool.kind === 'virtual_thread_executor'
        ? '虚拟线程 ExecutorService 没有 ThreadPoolExecutor 的运行指标 API；在业务准入与回调 finally 中独立统计已接收未结束、成功、失败和拒绝次数，用真实下游回调验收这些统计。'
        : '为这个线程池暴露 getQueue().size()、getActiveCount()、getCompletedTaskCount() 等运行指标，并单独统计拒绝次数。', pool.variableName));
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
