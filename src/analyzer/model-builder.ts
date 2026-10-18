/**
 * Builds the structured thread-pool model of a Java file.
 *
 * Two AST walks are performed: one for declarations (pools, variables, custom
 * implementations, annotations) and one for usages (submit / shutdown /
 * async / ThreadLocal / monitoring calls). All facts are collected into the
 * model, from which both semantic features and rule violations are derived.
 */
import { readFileSync } from 'node:fs';
import {
  callArguments,
  caughtTypesOfTry,
  childForField,
  compactText,
  declaredTypeOf,
  enclosingTry,
  isInFinally,
  lastIdentifier,
  methodNameOf,
  receiverName,
  receiverOf,
  textOf,
  typeNameOf,
  walk,
} from './ast-utils.ts';
import { evidenceOf, parseJava, type JavaSyntaxNode, type ParsedJavaFile } from './java-parser.ts';
import type {
  ArgFact,
  CustomImplFact,
  ExecutorRefFact,
  ExecutorResolution,
  JavaThreadPoolModel,
  PoolCreationFact,
  PoolKind,
  PoolScope,
  QueueFact,
  RejectionFact,
  RejectionKind,
  SubmitFact,
  ThreadFactoryFact,
} from './model.ts';

/** Blocking queue semantics used by the queue rules. */
const QUEUE_TYPES: Readonly<Record<string, { bounded: boolean; capacityControllable: boolean; reason: string }>> = {
  ArrayBlockingQueue: { bounded: true, capacityControllable: true, reason: '有界队列，容量必须显式指定' },
  LinkedBlockingQueue: { bounded: false, capacityControllable: true, reason: '不指定容量时最大长度为 Integer.MAX_VALUE，视为无界' },
  LinkedBlockingDeque: { bounded: false, capacityControllable: true, reason: '不指定容量时最大长度为 Integer.MAX_VALUE，视为无界' },
  SynchronousQueue: { bounded: true, capacityControllable: false, reason: '不缓存任务，不具备缓冲能力（容量为 0）' },
  PriorityBlockingQueue: { bounded: false, capacityControllable: false, reason: '无界优先级队列，任务会持续堆积' },
  DelayedWorkQueue: { bounded: false, capacityControllable: false, reason: '无界延迟队列（ScheduledThreadPoolExecutor 内部使用）' },
  LinkedTransferQueue: { bounded: false, capacityControllable: false, reason: '无界队列' },
  ConcurrentLinkedQueue: { bounded: false, capacityControllable: false, reason: '无界队列' },
};

/** Built-in rejection policies of `ThreadPoolExecutor`. */
const BUILTIN_HANDLERS: Readonly<Record<string, RejectionKind>> = {
  AbortPolicy: 'abort',
  CallerRunsPolicy: 'caller_runs',
  DiscardPolicy: 'discard',
  DiscardOldestPolicy: 'discard_oldest',
};

const EXECUTORS_FACTORIES: readonly string[] = [
  'newFixedThreadPool',
  'newSingleThreadExecutor',
  'newCachedThreadPool',
  'newScheduledThreadPool',
  'newSingleThreadScheduledExecutor',
  'newWorkStealingPool',
  'newThreadPerTaskExecutor',
  'newVirtualThreadPerTaskExecutor',
];

const SUBMIT_METHODS: readonly string[] = ['submit', 'execute', 'invokeAll', 'invokeAny', 'schedule', 'scheduleAtFixedRate', 'scheduleWithFixedDelay'];

const MONITOR_METHODS: readonly string[] = [
  'getQueue',
  'getActiveCount',
  'getPoolSize',
  'getLargestPoolSize',
  'getCompletedTaskCount',
  'getTaskCount',
  'getCorePoolSize',
  'getMaximumPoolSize',
  'getMaxPoolSize',
  'getKeepAliveTime',
  'getRejectedExecutionHandler',
  'getThreadPoolExecutor',
  'isShutdown',
  'isTerminated',
];

const EXECUTOR_TYPE_PATTERN = /(Executor|ExecutorService|ThreadPoolExecutor|ScheduledExecutorService|ThreadPoolTaskExecutor|ThreadPool)$/;
const EXECUTOR_NAME_HEURISTIC = /(executor|threadpool|thread_pool|pool|loom)/i;
const REPORTING_PATTERN = /(log\.|logger\.|LOG\.|System\.(?:out|err)|metrics|counter|Counter|meter|Meter|incrementAndGet|addAndGet|prometheus)/;
const INTEGER_MAX_VALUE = 2147483647;

interface BuilderState {
  parsed: ParsedJavaFile;
  poolId: number;
}

interface Registry {
  executorVars: Map<string, ExecutorRefFact>;
  futureVars: Set<string>;
  threadLocalVars: Set<string>;
  queueVars: Map<string, QueueFact>;
  handlerVars: Map<string, RejectionFact>;
}

export function readJavaFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/** Parses `filePath` and builds its thread pool model. */
export function analyzeJavaFile(filePath: string): { parsed: ParsedJavaFile; model: JavaThreadPoolModel } {
  const parsed = parseJava(readJavaFile(filePath), filePath);
  return { parsed, model: buildThreadPoolModel(parsed) };
}

export function buildThreadPoolModel(parsed: ParsedJavaFile): JavaThreadPoolModel {
  const state: BuilderState = { parsed, poolId: 0 };
  const lines = parsed.lines;
  const registry: Registry = {
    executorVars: new Map<string, ExecutorRefFact>(),
    futureVars: new Set<string>(),
    threadLocalVars: new Set<string>(),
    queueVars: new Map<string, QueueFact>(),
    handlerVars: new Map<string, RejectionFact>(),
  };
  const model: JavaThreadPoolModel = {
    filePath: parsed.filePath,
    packageName: '',
    imports: [],
    classNames: [],
    parseErrors: parsed.errors,
    pools: [],
    executors: [],
    submits: [],
    shutdowns: [],
    futureGets: [],
    asyncs: [],
    threadLocals: [],
    monitors: [],
    customImpls: [],
    interruptCatches: [],
    annotations: [],
    hasUncaughtExceptionHandler: parsed.code.includes('setUncaughtExceptionHandler'),
    hasPreDestroy: false,
    hasBeanManagedPool: false,
  };

  const declarationPass = (node: JavaSyntaxNode): void => {
    switch (node.type) {
      case 'package_declaration':
        model.packageName = textOf(node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')).trim();
        break;
      case 'import_declaration':
        model.imports.push(textOf(node.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')).trim());
        break;
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        const name = childForField(node, 'name')?.text;
        if (name !== undefined) model.classNames.push(name);
        const impl = detectCustomImplementation(node, lines);
        if (impl !== null) model.customImpls.push(impl);
        break;
      }
      case 'marker_annotation':
      case 'annotation': {
        const name = lastIdentifier(childForField(node, 'name')?.text ?? node.text.replace(/^@/, '').split('(')[0] ?? '');
        if (name.length > 0) {
          model.annotations.push(name);
          if (name === 'PreDestroy') model.hasPreDestroy = true;
        }
        break;
      }
      case 'field_declaration':
      case 'local_variable_declaration': {
        const declarator = childForField(node, 'declarator');
        if (declarator === null) break;
        registerDeclaration(state, node, declaredTypeOf(declarator), childForField(declarator, 'name')?.text ?? '', childForField(declarator, 'value'), lines, model, registry);
        break;
      }
      case 'object_creation_expression': {
        if (!isAssignedValue(node) && isPoolType(typeNameOf(node))) {
          model.pools.push(createPoolFact(state, node, { lines, registry }));
        }
        break;
      }
      case 'method_invocation': {
        if (!isAssignedValue(node) && isExecutorsFactory(node)) {
          model.pools.push(createPoolFact(state, node, { lines, registry }));
        }
        break;
      }
      case 'formal_parameter': {
        const declaredType = childForField(node, 'type')?.text ?? '';
        const name = childForField(node, 'name')?.text ?? '';
        registerExecutorType(registry, declaredType, name, evidenceOf(node, lines, name));
        if (/Future/.test(declaredType)) registry.futureVars.add(name);
        if (/ThreadLocal/.test(declaredType)) registry.threadLocalVars.add(name);
        break;
      }
      default:
        break;
    }
    for (const child of node.children) declarationPass(child);
  };
  declarationPass(parsed.rootNode);

  const usagePass = (node: JavaSyntaxNode): void => {
    if (node.type === 'method_invocation') {
      collectInvocationUsage(state, node, lines, model, registry);
    } else if (node.type === 'catch_clause') {
      collectInterruptCatch(node, lines, model);
    }
    for (const child of node.children) usagePass(child);
  };
  usagePass(parsed.rootNode);

  model.executors = [...registry.executorVars.values()];
  finalizeModel(model);
  return model;
}

/** Post-pass: Spring task executor default queue, `@PreDestroy` / `@Bean` flags. */
function finalizeModel(model: JavaThreadPoolModel): void {
  for (const pool of model.pools) {
    pool.hasPreDestroy = model.hasPreDestroy;
    if (pool.isBean) model.hasBeanManagedPool = true;
    if (pool.kind === 'spring_task_executor' && pool.queue === undefined) {
      pool.queue = syntheticQueue('LinkedBlockingQueue', undefined, pool.evidence);
    }
  }
}
/* ------------------------------------------------------------------ *
 * Literals, scopes and declarations
 * ------------------------------------------------------------------ */

/** Simple type name without generics: `Map<String, Executor>` -> `Map`. */
function baseTypeName(typeText: string): string {
  return lastIdentifier(typeText.replace(/<[\s\S]*>$/, '').trim());
}

function argFact(node: JavaSyntaxNode): ArgFact {
  const text = compactText(node);
  const fact: ArgFact = { text, isNull: /^null$/.test(text.trim()), nodeType: node.type };
  const number = numberFromText(text);
  if (number !== undefined) fact.number = number;
  return fact;
}

function numberFromText(text: string): number | undefined {
  const trimmed = text.trim();
  if (/(?:^|\.)Integer\.MAX_VALUE$/.test(trimmed)) return INTEGER_MAX_VALUE;
  // numeric separators (1_000) and literal suffixes (0L, 30D) are supported
  const digits = trimmed.replace(/_/g, '').replace(/[LlFfDd]$/, '');
  if (/^\d+$/.test(digits)) return Number.parseInt(digits, 10);
  return undefined;
}

function isAssignedValue(node: JavaSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null || parent === undefined) return false;
  if (parent.type === 'variable_declarator') return childForField(parent, 'value')?.id === node.id;
  if (parent.type === 'assignment_expression') return childForField(parent, 'right')?.id === node.id;
  return false;
}

function scopeOf(node: JavaSyntaxNode): { scope: PoolScope; isBean: boolean; modifiers: string[] } {
  const declarator = node.parent?.type === 'variable_declarator' ? node.parent : null;
  const declaration = declarator?.parent ?? null;
  const modifiers =
    declaration?.type === 'field_declaration' || declaration?.type === 'local_variable_declaration'
      ? (declaration.namedChildren.find((c) => c.type === 'modifiers')?.text ?? '').split(/\s+/).filter((m) => m.length > 0)
      : [];
  const method = enclosingMethodOf(node);
  const isBeanMethod = method !== null && methodAnnotationsOf(method).includes('Bean');
  if (declaration?.type === 'field_declaration') {
    return { scope: modifiers.includes('static') ? 'static_field' : 'field', isBean: isBeanMethod, modifiers };
  }
  if (declaration?.type === 'local_variable_declaration') {
    return { scope: isBeanMethod ? 'bean_method' : 'local', isBean: isBeanMethod, modifiers };
  }
  // `return new ThreadPoolExecutor(...)` inside an @Bean factory method: the pool
  // becomes a container managed singleton and must not be treated as a transient pool.
  const isReturnedFromBean = isBeanMethod && node.parent?.type === 'return_statement';
  return { scope: isReturnedFromBean ? 'bean_method' : 'expression', isBean: isBeanMethod, modifiers };
}

/** The closest enclosing method / constructor declaration. */
export function enclosingMethodOf(node: JavaSyntaxNode): JavaSyntaxNode | null {
  let current: JavaSyntaxNode | null | undefined = node.parent;
  while (current !== null && current !== undefined) {
    if (current.type === 'method_declaration' || current.type === 'constructor_declaration') return current;
    current = current.parent;
  }
  return null;
}

/** Names of the annotations declared on a method (`Bean`, `PreDestroy`, ...). */
export function methodAnnotationsOf(method: JavaSyntaxNode): string[] {
  const modifiers = method.namedChildren.find((c) => c.type === 'modifiers');
  if (modifiers === undefined) return [];
  const out: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      out.push(lastIdentifier(childForField(child, 'name')?.text ?? child.text.replace(/^@/, '')));
    }
  }
  return out;
}

function isExecutorType(baseType: string): boolean {
  if (baseType === 'Thread' || baseType === 'ThreadLocal' || baseType === 'ThreadFactory') return false;
  return EXECUTOR_TYPE_PATTERN.test(baseType);
}

function isPoolType(typeName: string): boolean {
  return typeName === 'ThreadPoolExecutor' || typeName === 'ScheduledThreadPoolExecutor' || typeName === 'ThreadPoolTaskExecutor';
}

function isExecutorsFactory(invocation: JavaSyntaxNode): boolean {
  const method = methodNameOf(invocation);
  if (!EXECUTORS_FACTORIES.includes(method)) return false;
  const receiver = receiverText(invocation);
  return receiver === 'Executors' || receiver.endsWith('.Executors');
}

function receiverText(invocation: JavaSyntaxNode): string {
  const receiver = receiverOf(invocation);
  return receiver === null ? '' : receiver.text.trim();
}

function registerExecutorType(registry: Registry, declaredType: string, name: string, evidence: ExecutorRefFact['evidence']): void {
  const baseType = baseTypeName(declaredType);
  if (name.length === 0 || !isExecutorType(baseType)) return;
  registry.executorVars.set(name, { name, declaredType: baseType, resolution: 'declared', evidence });
}
/** Registers a variable / field declaration and any thread pool it creates. */
function registerDeclaration(
  state: BuilderState,
  declaration: JavaSyntaxNode,
  declaredType: string,
  name: string,
  value: JavaSyntaxNode | null,
  lines: string[],
  model: JavaThreadPoolModel,
  registry: Registry,
): void {
  const baseType = baseTypeName(declaredType);
  const evidence = evidenceOf(declaration, lines, name);
  if (name.length > 0) {
    if (/Future/.test(declaredType)) registry.futureVars.add(name);
    if (/ThreadLocal/.test(declaredType)) {
      registry.threadLocalVars.add(name);
      model.threadLocals.push({ kind: 'declare', name, inFinally: false, evidence });
    }
    if (value !== null && value.type === 'object_creation_expression' && QUEUE_TYPES[typeNameOf(value)] !== undefined) {
      registry.queueVars.set(name, queueFactFromNode(value, typeNameOf(value), lines));
    }
    if (/(Policy|Handler)$/.test(baseType) && value !== null) {
      registry.handlerVars.set(name, buildRejectionFact(value, lines));
    }
    if (isExecutorType(baseType)) {
      registry.executorVars.set(name, { name, declaredType: baseType, resolution: value === null ? 'declared' : 'initializer', evidence });
    }
  }
  if (value === null) return;
  if (value.type === 'object_creation_expression' && isPoolType(typeNameOf(value))) {
    model.pools.push(createPoolFact(state, value, { variableName: name, declaredType: baseType, lines, registry }));
    return;
  }
  if (value.type === 'method_invocation' && isExecutorsFactory(value)) {
    model.pools.push(createPoolFact(state, value, { variableName: name, declaredType: baseType, lines, registry }));
  }
}

/* ------------------------------------------------------------------ *
 * Pool creation facts
 * ------------------------------------------------------------------ */

interface PoolSiteOptions {
  variableName?: string;
  declaredType?: string;
  lines: string[];
  registry: Registry;
}

/** Builds a `PoolCreationFact` for an object creation or an `Executors` factory call. */
function createPoolFact(state: BuilderState, node: JavaSyntaxNode, options: PoolSiteOptions): PoolCreationFact {
  const { lines, registry } = options;
  const isInvocation = node.type === 'method_invocation';
  const typeName = isInvocation ? 'Executors' : typeNameOf(node);
  const factoryMethod = isInvocation ? methodNameOf(node) : undefined;
  const args = callArguments(node);
  const isScheduled = isInvocation ? /Scheduled/.test(factoryMethod ?? '') : typeName === 'ScheduledThreadPoolExecutor';
  const kind: PoolKind = isInvocation
    ? factoryMethod === 'newVirtualThreadPerTaskExecutor' || factoryMethod === 'newThreadPerTaskExecutor'
      ? 'virtual_thread_executor'
      : 'executors_factory'
    : typeName === 'ThreadPoolTaskExecutor'
      ? 'spring_task_executor'
      : isScheduled
        ? 'scheduled_thread_pool_executor'
        : 'thread_pool_executor';
  const scopeInfo = scopeOf(node);
  const fact: PoolCreationFact = {
    id: `pool-${++state.poolId}`,
    kind,
    scope: scopeInfo.scope,
    modifiers: scopeInfo.modifiers,
    isBean: scopeInfo.isBean,
    hasPreDestroy: false,
    isScheduled,
    argCount: args.length,
    evidence: evidenceOf(node, lines, options.variableName),
    node,
  };
  if (factoryMethod !== undefined) fact.factoryMethod = factoryMethod;
  if (options.variableName !== undefined && options.variableName.length > 0) fact.variableName = options.variableName;
  if (options.declaredType !== undefined && options.declaredType.length > 0) fact.declaredType = options.declaredType;

  const at = (index: number): JavaSyntaxNode | undefined => args[index];
  if (isInvocation) {
    applyFactoryDefaults(fact, args);
  } else if (kind === 'thread_pool_executor') {
    // ThreadPoolExecutor(int, int, long, TimeUnit, BlockingQueue[, ThreadFactory][, RejectedExecutionHandler])
    const [core, max, keepAlive, unit, queue, sixth, seventh] = [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
    if (core !== undefined) fact.coreSize = argFact(core);
    if (max !== undefined) fact.maxSize = argFact(max);
    if (keepAlive !== undefined) fact.keepAlive = argFact(keepAlive);
    if (unit !== undefined) fact.timeUnit = compactText(unit);
    if (queue !== undefined) fact.queue = buildQueueFact(queue, lines, registry);
    if (sixth !== undefined) {
      if (isFactoryArg(sixth)) fact.threadFactory = buildThreadFactoryFact(sixth, lines);
      else fact.rejection = resolveRejectionFact(sixth, lines, registry);
    }
    if (seventh !== undefined) fact.rejection = resolveRejectionFact(seventh, lines, registry);
  } else if (kind === 'scheduled_thread_pool_executor') {
    // ScheduledThreadPoolExecutor(int[, ThreadFactory | RejectedExecutionHandler][, RejectedExecutionHandler])
    const [core, second, third] = [at(0), at(1), at(2)];
    if (core !== undefined) {
      fact.coreSize = argFact(core);
      fact.maxSize = argFact(core);
    }
    if (second !== undefined) {
      if (isFactoryArg(second)) fact.threadFactory = buildThreadFactoryFact(second, lines);
      else if (isHandlerArg(second)) fact.rejection = resolveRejectionFact(second, lines, registry);
    }
    if (third !== undefined) fact.rejection = resolveRejectionFact(third, lines, registry);
  }
  return fact;
}
/* ------------------------------------------------------------------ *
 * Queues, thread factories, rejection handlers
 * ------------------------------------------------------------------ */

function syntheticArg(text: string): ArgFact {
  const fact: ArgFact = { text, isNull: false, nodeType: 'synthetic' };
  const number = numberFromText(text);
  if (number !== undefined) fact.number = number;
  return fact;
}

function syntheticQueue(typeName: string, capacity: number | undefined, evidence: QueueFact['evidence']): QueueFact {
  const meta = QUEUE_TYPES[typeName];
  const fact: QueueFact = {
    typeName,
    bounded: (meta?.bounded ?? false) || (capacity !== undefined && (meta?.capacityControllable ?? false)),
    capacityControllable: meta?.capacityControllable ?? false,
    reason: meta?.reason ?? '',
    evidence,
  };
  if (capacity !== undefined) {
    fact.capacity = capacity;
    fact.capacityText = String(capacity);
  }
  return fact;
}

/** Applies the documented semantics of the `Executors` convenience factories. */
function applyFactoryDefaults(fact: PoolCreationFact, args: JavaSyntaxNode[]): void {
  const firstArg = args[0] === undefined ? undefined : compactText(args[0]);
  switch (fact.factoryMethod) {
    case 'newFixedThreadPool':
      fact.coreSize = syntheticArg(firstArg ?? 'unset');
      fact.maxSize = syntheticArg(firstArg ?? 'unset');
      fact.queue = syntheticQueue('LinkedBlockingQueue', undefined, fact.evidence);
      break;
    case 'newSingleThreadExecutor':
      fact.coreSize = syntheticArg('1');
      fact.maxSize = syntheticArg('1');
      fact.queue = syntheticQueue('LinkedBlockingQueue', undefined, fact.evidence);
      break;
    case 'newCachedThreadPool':
      fact.coreSize = syntheticArg('0');
      fact.maxSize = syntheticArg('Integer.MAX_VALUE');
      fact.queue = syntheticQueue('SynchronousQueue', 0, fact.evidence);
      break;
    case 'newScheduledThreadPool':
    case 'newSingleThreadScheduledExecutor': {
      const size = fact.factoryMethod === 'newSingleThreadScheduledExecutor' ? '1' : (firstArg ?? 'unset');
      fact.coreSize = syntheticArg(size);
      fact.maxSize = syntheticArg(size);
      break;
    }
    case 'newWorkStealingPool':
      fact.coreSize = syntheticArg(firstArg ?? 'unset');
      break;
    default:
      break;
  }
}

function isFactoryArg(node: JavaSyntaxNode): boolean {
  if (node.type === 'lambda_expression') return lambdaArity(node) !== 2;
  if (node.type === 'object_creation_expression') return /ThreadFactory$/.test(typeNameOf(node));
  const text = compactText(node);
  if (/(RejectedExecutionHandler|Policy|Handler)/.test(text)) return false;
  return /(ThreadFactory|Factory)/.test(text);
}

function isHandlerArg(node: JavaSyntaxNode): boolean {
  if (node.type === 'lambda_expression') return lambdaArity(node) === 2;
  if (node.type === 'object_creation_expression') {
    const typeName = typeNameOf(node);
    return BUILTIN_HANDLERS[typeName] !== undefined || /(Policy|Handler|Report)$/.test(typeName);
  }
  return /(RejectedExecutionHandler|Policy|Handler|Report)/.test(compactText(node));
}

/** Number of parameters of a lambda: `task -> ...` = 1, `(task, executor) -> ...` = 2. */
function lambdaArity(node: JavaSyntaxNode): number {
  const parameters = childForField(node, 'parameters');
  if (parameters === null) return 1;
  if (parameters.type === 'identifier') return 1;
  return parameters.namedChildren.filter((child) => child.type !== 'comment').length;
}

/** Method names invoked inside a subtree. */
function invokedMethodNames(node: JavaSyntaxNode): string[] {
  const names: string[] = [];
  walk(node, (current) => {
    if (current.type === 'method_invocation') names.push(methodNameOf(current));
  });
  return names;
}

function containsThrowStatement(node: JavaSyntaxNode): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === 'throw_statement') found = true;
  });
  return found;
}
function buildThreadFactoryFact(node: JavaSyntaxNode, lines: string[]): ThreadFactoryFact {
  const fact: ThreadFactoryFact = {
    typeName: node.type === 'object_creation_expression' ? typeNameOf(node) : node.type === 'lambda_expression' ? '<lambda>' : compactText(node),
    expression: compactText(node),
    evidence: evidenceOf(node, lines),
  };
  if (node.type === 'object_creation_expression' || node.type === 'lambda_expression') {
    if (invokedMethodNames(node).includes('setName')) fact.setsName = true;
  }
  return fact;
}

/** Resolves a rejection handler argument, following variables declared in the file. */
function resolveRejectionFact(node: JavaSyntaxNode, lines: string[], registry: Registry): RejectionFact {
  if (node.type === 'identifier') {
    const known = registry.handlerVars.get(node.text.trim());
    if (known !== undefined) return known;
  }
  return buildRejectionFact(node, lines);
}

function buildRejectionFact(node: JavaSyntaxNode, lines: string[]): RejectionFact {
  const evidence = evidenceOf(node, lines);
  if (node.type === 'lambda_expression') return { typeName: '<lambda>', kind: 'custom', evidence };
  if (node.type === 'object_creation_expression') {
    const typeName = typeNameOf(node);
    const builtin = BUILTIN_HANDLERS[typeName];
    return { typeName, kind: builtin ?? (/(Policy|Handler)$/.test(typeName) ? 'custom' : 'unknown'), evidence };
  }
  const text = compactText(node);
  const builtin = BUILTIN_HANDLERS[lastIdentifier(text)];
  if (builtin !== undefined) return { typeName: lastIdentifier(text), kind: builtin, evidence };
  return { typeName: text, kind: 'custom', evidence };
}

function buildQueueFact(node: JavaSyntaxNode, lines: string[], registry: Registry): QueueFact | undefined {
  if (node.type === 'identifier' || node.type === 'field_access') {
    return registry.queueVars.get(receiverName(node)) ?? registry.queueVars.get(lastIdentifier(node.text));
  }
  if (node.type === 'object_creation_expression') {
    const typeName = typeNameOf(node);
    if (QUEUE_TYPES[typeName] === undefined) return undefined;
    return queueFactFromNode(node, typeName, lines);
  }
  return undefined;
}

function queueFactFromNode(node: JavaSyntaxNode, typeName: string, lines: string[]): QueueFact {
  const args = callArguments(node);
  const capacityText = args[0] === undefined ? undefined : compactText(args[0]);
  const capacity = capacityText === undefined ? undefined : numberFromText(capacityText);
  const meta = QUEUE_TYPES[typeName];
  const fact: QueueFact = {
    typeName,
    bounded: (meta?.bounded ?? false) || (capacity !== undefined && (meta?.capacityControllable ?? false)),
    capacityControllable: meta?.capacityControllable ?? false,
    reason: meta?.reason ?? '未知队列类型',
    evidence: evidenceOf(node, lines),
  };
  if (capacity !== undefined) fact.capacity = capacity;
  if (capacityText !== undefined) fact.capacityText = capacityText;
  return fact;
}
/* ------------------------------------------------------------------ *
 * Custom implementations
 * ------------------------------------------------------------------ */

function detectCustomImplementation(classNode: JavaSyntaxNode, lines: string[]): CustomImplFact | null {
  const implemented = implementedTypeNames(classNode);
  const kind = implemented.includes('ThreadFactory')
    ? 'thread_factory'
    : implemented.includes('RejectedExecutionHandler')
      ? 'rejection_handler'
      : null;
  if (kind === null) return null;
  const className = childForField(classNode, 'name')?.text ?? '<anonymous>';
  const body = childForField(classNode, 'body');
  const names = body === null ? [] : invokedMethodNames(body);
  return {
    kind,
    className,
    hasSetName: names.includes('setName'),
    hasReporting: REPORTING_PATTERN.test(body?.text ?? ''),
    evidence: evidenceOf(classNode, lines, className),
  };
}

function implementedTypeNames(classNode: JavaSyntaxNode): string[] {
  const names: string[] = [];
  const superclass = childForField(classNode, 'superclass');
  if (superclass !== null) names.push(lastIdentifier(superclass.text));
  const interfaces = childForField(classNode, 'interfaces');
  if (interfaces !== null) {
    for (const list of interfaces.namedChildren) {
      if (list.type !== 'type_list') continue;
      for (const type of list.namedChildren) names.push(lastIdentifier(type.text));
    }
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * Usage pass
 * ------------------------------------------------------------------ */

function resolveExecutor(receiver: string, receiverNode: JavaSyntaxNode | null, registry: Registry): ExecutorResolution | 'unresolved' {
  if (receiver.length === 0) return 'unresolved';
  const known = registry.executorVars.get(receiver);
  if (known !== undefined) return known.resolution;
  if (receiverNode?.type === 'method_invocation' && EXECUTORS_FACTORIES.includes(methodNameOf(receiverNode))) return 'initializer';
  return EXECUTOR_NAME_HEURISTIC.test(receiver) ? 'heuristic' : 'unresolved';
}

function isCompletableFutureCall(node: JavaSyntaxNode, receiver: string, registry: Registry): boolean {
  if (/^CompletableFuture\./.test(node.text.trim())) return true;
  if (/CompletableFuture/.test(receiver)) return true;
  return registry.futureVars.has(receiver);
}
function collectInvocationUsage(
  state: BuilderState,
  node: JavaSyntaxNode,
  lines: string[],
  model: JavaThreadPoolModel,
  registry: Registry,
): void {
  const method = methodNameOf(node);
  const receiverNode = receiverOf(node);
  const receiver = receiverName(receiverNode);
  if (isExecutorsFactory(node) && !isAssignedValue(node)) {
    model.pools.push(createPoolFact(state, node, { lines, registry }));
  }
  const tryNode = enclosingTry(node);
  const insideTry = tryNode !== null;
  const caughtTypes = tryNode === null ? [] : caughtTypesOfTry(tryNode);

  if (SUBMIT_METHODS.includes(method)) {
    const task = callArguments(node)[0] ?? null;
    const submit: SubmitFact = {
      method,
      receiver,
      receiverResolution: resolveExecutor(receiver, receiverNode, registry),
      resultUsed: node.parent?.type !== 'expression_statement',
      insideTry,
      caughtTypes,
      taskThrows: task !== null && containsThrowStatement(task),
      evidence: evidenceOf(node, lines, receiver),
      node,
    };
    model.submits.push(submit);
  }

  const resultUsed = node.parent?.type !== 'expression_statement';
  if (method === 'shutdown' || method === 'shutdownNow' || method === 'awaitTermination') {
    model.shutdowns.push({ method, receiver, argCount: callArguments(node).length, insideTry, resultUsed, evidence: evidenceOf(node, lines, receiver), node });
  } else if (method === 'close' && resolveExecutor(receiver, receiverNode, registry) !== 'unresolved') {
    model.shutdowns.push({ method: 'close', receiver, argCount: 0, insideTry, resultUsed, evidence: evidenceOf(node, lines, receiver), node });
  }

  if (method === 'get' || method === 'join') {
    const isFutureReceiver =
      registry.futureVars.has(receiver) ||
      /Future/.test(receiverNode?.text ?? '') ||
      (receiverNode !== null && receiverNode.type === 'method_invocation' && SUBMIT_METHODS.includes(methodNameOf(receiverNode)));
    if (isFutureReceiver) {
      model.futureGets.push({ receiver, hasTimeout: method === 'get' && callArguments(node).length >= 1, evidence: evidenceOf(node, lines, receiver) });
    }
  }

  if (/Async$/.test(method) && isCompletableFutureCall(node, receiver, registry)) {
    // *Async(supplier) uses the common pool; passing the executor requires a second argument
    // (`supplyAsync(supplier, executor)`, `thenApplyAsync(fn, executor)`, ...).
    const argCount = callArguments(node).length;
    model.asyncs.push({
      kind: 'completable_future',
      method,
      hasExplicitExecutor: argCount >= 2,
      evidence: evidenceOf(node, lines, receiver),
    });
  }

  if (method === 'ofVirtual' || method === 'startVirtualThread' || method === 'newVirtualThreadPerTaskExecutor') {
    model.asyncs.push({ kind: 'virtual_thread', method, hasExplicitExecutor: true, evidence: evidenceOf(node, lines, receiver) });
  }

  if (registry.threadLocalVars.has(receiver) && (method === 'set' || method === 'get' || method === 'remove')) {
    model.threadLocals.push({ kind: method, name: receiver, method, inFinally: isInFinally(node), evidence: evidenceOf(node, lines, receiver) });
  } else if (receiver === 'MDC' && (method === 'put' || method === 'remove' || method === 'clear')) {
    model.threadLocals.push({
      kind: method === 'put' ? 'set' : 'remove',
      name: 'MDC',
      method,
      inFinally: isInFinally(node),
      evidence: evidenceOf(node, lines, receiver),
    });
  } else if (method === 'withInitial') {
    model.threadLocals.push({ kind: 'declare', name: receiver, method, inFinally: false, evidence: evidenceOf(node, lines, receiver) });
  }

  if (MONITOR_METHODS.includes(method) && resolveExecutor(receiver, receiverNode, registry) !== 'unresolved') {
    model.monitors.push({ method, receiver, evidence: evidenceOf(node, lines, receiver) });
  }

  if (method === 'setUncaughtExceptionHandler') model.hasUncaughtExceptionHandler = true;

  applySpringSetter(model, method, receiver, node, lines);
}
/** Attaches `ThreadPoolTaskExecutor` setter calls to the matching pool fact. */
function applySpringSetter(model: JavaThreadPoolModel, method: string, receiver: string, node: JavaSyntaxNode, lines: string[]): void {
  const pool = model.pools.find((candidate) => candidate.variableName === receiver);
  if (pool === undefined) return;
  const first = callArguments(node)[0];
  if (first === undefined) return;
  switch (method) {
    case 'setCorePoolSize':
      pool.coreSize = argFact(first);
      break;
    case 'setMaxPoolSize':
    case 'setMaximumPoolSize':
      pool.maxSize = argFact(first);
      break;
    case 'setKeepAliveSeconds':
    case 'setKeepAliveTime':
      pool.keepAlive = argFact(first);
      break;
    case 'setQueueCapacity': {
      const capacity = numberFromText(compactText(first));
      pool.queue =
        capacity === 0
          ? syntheticQueue('SynchronousQueue', 0, evidenceOf(first, lines))
          : {
              typeName: 'LinkedBlockingQueue',
              bounded: true,
              capacityControllable: true,
              reason: 'ThreadPoolTaskExecutor 队列容量由 setQueueCapacity 指定',
              evidence: evidenceOf(first, lines),
              capacity: capacity ?? 0,
              capacityText: compactText(first),
            };
      break;
    }
    case 'setThreadNamePrefix':
      pool.threadFactory = { typeName: 'thread-name-prefix', expression: compactText(first), setsName: true, evidence: evidenceOf(first, lines) };
      break;
    case 'setThreadFactory':
      pool.threadFactory = buildThreadFactoryFact(first, lines);
      break;
    case 'setRejectedExecutionHandler':
      pool.rejection = buildRejectionFact(first, lines);
      break;
    default:
      break;
  }
}

/** `catch (InterruptedException)` must restore the interrupt flag (or rethrow). */
function collectInterruptCatch(node: JavaSyntaxNode, lines: string[], model: JavaThreadPoolModel): void {
  const parameter = node.namedChildren.find((child) => child.type === 'catch_formal_parameter');
  if (parameter === undefined) return;
  const catchType = parameter.namedChildren.find((child) => child.type === 'catch_type');
  if (lastIdentifier(catchType?.text ?? '') !== 'InterruptedException') return;
  const body = childForField(node, 'body');
  const names = body === null ? [] : invokedMethodNames(body);
  model.interruptCatches.push({
    restored: names.includes('interrupt') || (body !== null && containsThrowStatement(body)),
    variableName: childForField(parameter, 'name')?.text ?? '',
    evidence: evidenceOf(node, lines),
  });
}
