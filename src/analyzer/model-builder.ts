/**
 * Builds the structured thread-pool model of a Java file.
 *
 * Two AST walks are performed: one for declarations (pools, variables, custom
 * implementations, annotations) and one for usages (submit / shutdown /
 * async / ThreadLocal / monitoring calls). All facts are collected into the
 * model, from which both semantic features and rule violations are derived.
 */
import { interruptRestored } from './interrupt-flow.ts';
import { JavaSymbols, enclosing } from './java-symbols.ts';
import { readFileSync } from 'node:fs';
import {
  callArguments,
  caughtTypesOfTry,
  childForField,
  compactText,
  declaredTypeOf,
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
];

const EXECUTOR_TYPES = new Set(['Executor','ExecutorService','ScheduledExecutorService','ThreadPoolExecutor','ScheduledThreadPoolExecutor','ForkJoinPool','ThreadPoolTaskExecutor','ThreadPoolTaskScheduler','TaskExecutor','AsyncTaskExecutor']);
const INTEGER_MAX_VALUE = 2147483647;

interface BuilderState {
  parsed: ParsedJavaFile;
  poolId: number;
  symbols: JavaSymbols;
}

interface Registry {
  executorVars: Map<string, ExecutorRefFact>;
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
  const state: BuilderState = { parsed, poolId: 0, symbols: new JavaSymbols(parsed.rootNode) };
  const lines = parsed.lines;
  const registry: Registry = {
    executorVars: new Map<string, ExecutorRefFact>(),
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
    hasUncaughtExceptionHandler: false,
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
        for (const declarator of node.namedChildren.filter(n => n.type === 'variable_declarator')) {
          registerDeclaration(state, node, declaredTypeOf(declarator), childForField(declarator, 'name')?.text ?? '', childForField(declarator, 'value'), lines, model, registry);
        }
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
        break;
      }
      case 'assignment_expression': {
        const value = childForField(node, 'right');
        if (value && ((value.type === 'object_creation_expression' && isPoolType(typeNameOf(value))) ||
            (value.type === 'method_invocation' && isExecutorsFactory(value)))) {
          const name = receiverName(childForField(node, 'left'));
          model.pools.push(createPoolFact(state, value, { variableName: name, declaredType: state.symbols.typeOf(childForField(node, 'left')), lines, registry }));
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.children) declarationPass(child);
  };
  declarationPass(parsed.rootNode);
  promoteConstructorOwnedPools(parsed.rootNode, model);
  attachContainerOwnership(state.symbols, model);

  const usagePass = (node: JavaSyntaxNode): void => {
    if (node.type === 'method_invocation') {
      collectInvocationUsage(state, node, lines, model, registry);
    } else if (node.type === 'catch_clause') {
      collectInterruptCatch(node, lines, model, state.symbols);
    }
    for (const child of node.children) usagePass(child);
  };
  usagePass(parsed.rootNode);

  model.executors = [...registry.executorVars.values()];
  finalizeModel(model);
  return model;
}

/** One-hop ownership only: direct constructor assignments or a private factory used solely for field initialization. */
function promoteConstructorOwnedPools(root: JavaSyntaxNode, model: JavaThreadPoolModel): void {
  const nodes: JavaSyntaxNode[] = [];
  walk(root, node => nodes.push(node));
  const owner = (node: JavaSyntaxNode): JavaSyntaxNode | null => {
    let current = node.parent;
    while (current && current.type !== 'class_body' && current.type !== 'enum_body') current = current.parent;
    return current;
  };
  const fields = nodes.filter(n => n.type === 'variable_declarator' && n.parent?.type === 'field_declaration');
  const fieldTarget = (value: JavaSyntaxNode): JavaSyntaxNode | undefined => {
    for (let ancestor = value.parent; ancestor && ancestor.type !== 'method_declaration' && ancestor.type !== 'constructor_declaration'; ancestor = ancestor.parent) {
      if (ancestor.type === 'lambda_expression') return undefined;
    }
    const parent = value.parent;
    if (parent?.type === 'variable_declarator' && parent.parent?.type === 'field_declaration') return parent;
    if (parent?.type !== 'assignment_expression' || enclosingMethodOf(parent)?.type !== 'constructor_declaration') return undefined;
    const left = childForField(parent, 'left');
    if (!left || (left.type !== 'identifier' && !(left.type === 'field_access' && childForField(left, 'object')?.text === 'this'))) return undefined;
    const name = receiverName(left);
    if (left.type === 'identifier') {
      const method = enclosingMethodOf(parent)!;
      if (nodes.some(n => enclosingMethodOf(n)?.id === method.id &&
          ((n.type === 'formal_parameter' && childForField(n, 'name')?.text === name) ||
           (n.type === 'variable_declarator' && n.parent?.type === 'local_variable_declaration' && childForField(n, 'name')?.text === name)))) return undefined;
    }
    return fields.find(field => owner(field)?.id === owner(value)?.id && childForField(field, 'name')?.text === name);
  };
  const escapesAs = (pool: PoolCreationFact, method: JavaSyntaxNode): JavaSyntaxNode[] => {
    const variable = pool.node.parent?.type === 'variable_declarator' ? childForField(pool.node.parent, 'name')?.text : undefined;
    if (variable && nodes.some(n => n.type === 'assignment_expression' && enclosingMethodOf(n)?.id === method.id && childForField(n, 'left')?.text === variable)) return [];
    return nodes.filter(n => enclosingMethodOf(n)?.id === method.id && n.type === 'return_statement' &&
      (n.namedChildren[0]?.id === pool.node.id || (variable !== undefined && n.namedChildren[0]?.text === variable)));
  };
  const promote = (pool: PoolCreationFact, field: JavaSyntaxNode): void => {
    const modifiers = (field.parent?.namedChildren.find(n => n.type === 'modifiers')?.text ?? '').split(/\s+/).filter(Boolean);
    pool.scope = modifiers.includes('static') ? 'static_field' : 'field';
    pool.modifiers = modifiers;
    pool.variableName = childForField(field, 'name')?.text;
  };
  for (const pool of model.pools) {
    if (pool.scope === 'field' || pool.scope === 'static_field' || pool.isBean) continue;
    const direct = fieldTarget(pool.node);
    if (direct) { promote(pool, direct); continue; }
    const method = enclosingMethodOf(pool.node);
    if (!method) continue;
    if (method.type === 'constructor_declaration' && pool.node.parent?.type === 'variable_declarator') {
      const local = childForField(pool.node.parent, 'name')?.text;
      const writes = nodes.filter(n => n.type === 'assignment_expression' && enclosingMethodOf(n)?.id === method.id && childForField(n, 'left')?.text === local);
      if (writes.length) continue;
      const targets = nodes.filter(n => n.type === 'identifier' && n.text === local && enclosingMethodOf(n)?.id === method.id)
        .map(n => fieldTarget(n)).filter((n): n is JavaSyntaxNode => n !== undefined);
      if (targets.length === 1) promote(pool, targets[0]!);
      continue;
    }
    const modifiers = method.namedChildren.find(n => n.type === 'modifiers')?.text ?? '';
    if (!/\bprivate\b/.test(modifiers) || escapesAs(pool, method).length !== 1) continue;
    const name = childForField(method, 'name')?.text;
    if (nodes.filter(n => n.type === 'method_declaration' && owner(n)?.id === owner(method)?.id && childForField(n, 'name')?.text === name).length !== 1) continue;
    const className = childForField(owner(method)?.parent ?? null, 'name')?.text;
    const calls = nodes.filter(n => n.type === 'method_invocation' && methodNameOf(n) === name && owner(n)?.id === owner(method)?.id &&
      (!receiverOf(n) || ['this', className].includes(receiverOf(n)?.text)));
    const targets = calls.map(fieldTarget);
    if (targets.length > 0 && targets.every((target): target is JavaSyntaxNode => target !== undefined) &&
        new Set(targets.map(n => n.id)).size === 1) promote(pool, targets[0]!);
  }
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
  const nearestExecution = enclosing(node, ['lambda_expression','method_declaration','constructor_declaration']);
  const isBeanMethod = method !== null && nearestExecution?.id === method.id && methodAnnotationsOf(method).includes('Bean');
  if (declaration?.type === 'field_declaration') {
    return { scope: modifiers.includes('static') ? 'static_field' : 'field', isBean: isBeanMethod, modifiers };
  }
  if (declaration?.type === 'local_variable_declaration') {
    return { scope: isBeanMethod ? 'bean_method' : 'local', isBean: isBeanMethod, modifiers };
  }
  // `return new ThreadPoolExecutor(...)` inside an @Bean factory method: the pool
  // becomes a container managed singleton and must not be treated as a transient pool.
  return { scope: isBeanMethod ? 'bean_method' : 'expression', isBean: isBeanMethod, modifiers };
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
  return EXECUTOR_TYPES.has(baseType);
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
  registry.executorVars.set(`${evidence.startLine}:${evidence.startColumn}:${name}`, { name, declaredType: baseType, resolution: 'declared', evidence });
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
    if (/ThreadLocal/.test(declaredType)) {
      model.threadLocals.push({ kind: 'declare', name, inFinally: false, evidence, node: declaration });
    }
    if (isExecutorType(baseType)) {
      registry.executorVars.set(`${evidence.startLine}:${evidence.startColumn}:${name}`, { name, declaredType: baseType, resolution: value === null ? 'declared' : 'initializer', evidence });
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
    ? factoryMethod === 'newVirtualThreadPerTaskExecutor'
      ? 'virtual_thread_executor'
      : factoryMethod === 'newThreadPerTaskExecutor' ? 'thread_per_task_executor' : 'executors_factory'
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
    const factoryIndex = ['newFixedThreadPool', 'newScheduledThreadPool'].includes(factoryMethod ?? '') ? 1 : 0;
    if (!['newWorkStealingPool','newVirtualThreadPerTaskExecutor'].includes(factoryMethod ?? '') && args[factoryIndex]) {
      fact.threadFactory = buildThreadFactoryFact(args[factoryIndex]!, lines, state.symbols);
    }
  } else if (kind === 'thread_pool_executor') {
    // ThreadPoolExecutor(int, int, long, TimeUnit, BlockingQueue[, ThreadFactory][, RejectedExecutionHandler])
    const [core, max, keepAlive, unit, queue, sixth, seventh] = [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
    if (core !== undefined) fact.coreSize = resolvedArg(core, state.symbols);
    if (max !== undefined) fact.maxSize = resolvedArg(max, state.symbols);
    if (keepAlive !== undefined) fact.keepAlive = resolvedArg(keepAlive, state.symbols);
    if (unit !== undefined) fact.timeUnit = compactText(unit);
    if (queue !== undefined) {
      const queueNode = state.symbols.origin(queue) ?? queue;
      fact.queue = buildQueueFact(queueNode, lines, registry);
      if (fact.queue && fact.queue.capacityText && fact.queue.capacity === undefined) {
        const capacityNode = callArguments(queueNode)[0];
        const capacity = state.symbols.integer(capacityNode ?? null);
        if (capacity !== undefined) { fact.queue.capacity = capacity; fact.queue.bounded = fact.queue.capacityControllable && capacity < INTEGER_MAX_VALUE; }
      }
    }
    if (sixth !== undefined) {
      if (isFactoryArg(sixth, state.symbols)) fact.threadFactory = buildThreadFactoryFact(sixth, lines, state.symbols);
      else fact.rejection = buildRejectionFact(state.symbols.origin(sixth) ?? sixth, lines);
    }
    if (seventh !== undefined) fact.rejection = buildRejectionFact(state.symbols.origin(seventh) ?? seventh, lines);
  } else if (kind === 'scheduled_thread_pool_executor') {
    // ScheduledThreadPoolExecutor(int[, ThreadFactory | RejectedExecutionHandler][, RejectedExecutionHandler])
    const [core, second, third] = [at(0), at(1), at(2)];
    if (core !== undefined) {
      fact.coreSize = resolvedArg(core, state.symbols);
      fact.maxSize = resolvedArg(core, state.symbols);
    }
    if (second !== undefined) {
      if (isFactoryArg(second, state.symbols)) fact.threadFactory = buildThreadFactoryFact(second, lines, state.symbols);
      else if (isHandlerArg(second)) fact.rejection = buildRejectionFact(state.symbols.origin(second) ?? second, lines);
    }
    if (third !== undefined) fact.rejection = buildRejectionFact(state.symbols.origin(third) ?? third, lines);
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
    bounded: (meta?.bounded ?? false) || (capacity !== undefined && capacity < INTEGER_MAX_VALUE && (meta?.capacityControllable ?? false)),
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

function isFactoryArg(node: JavaSyntaxNode, symbols?: JavaSymbols): boolean {
  if (/ThreadFactory/.test(symbols?.typeOf(node) ?? '')) return true;
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
function buildThreadFactoryFact(node: JavaSyntaxNode, lines: string[], symbols?: JavaSymbols): ThreadFactoryFact {
  const fact: ThreadFactoryFact = {
    typeName: node.type === 'object_creation_expression' ? typeNameOf(node) : node.type === 'lambda_expression' ? '<lambda>' : compactText(node),
    expression: compactText(node),
    evidence: evidenceOf(node, lines),
  };
  const classDeclaration = node.type === 'object_creation_expression' && !childForField(node, 'body') ? symbols?.nodes.find(n => n.type === 'class_declaration' && childForField(n, 'name')?.text === typeNameOf(node)) : undefined;
  const implementation = classDeclaration ?? (node.type === 'method_invocation' ? symbols?.method(node) : symbols?.origin(node)) ?? node;
  if (['lambda_expression', 'method_declaration', 'class_declaration'].includes(implementation.type) || (implementation.type === 'object_creation_expression' && implementation.namedChildren.some(n => n.type === 'class_body'))) {
    fact.setsName = invokedMethodNames(implementation).includes('setName') || /new\s+Thread\([^,]+,/.test(implementation.text);
    fact.handlesExceptions = symbols?.nodes.some(n => n.type === 'method_invocation' &&
      n.startIndex >= implementation.startIndex && n.endIndex <= implementation.endIndex && methodNameOf(n) === 'setUncaughtExceptionHandler' &&
      baseTypeName(symbols.typeOf(receiverOf(n))) === 'Thread') ?? false;
  }
  return fact;
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
    return undefined; // unresolved queue type/capacity must not borrow another scope's declaration
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
    bounded: (meta?.bounded ?? false) || (capacityText !== undefined && capacity !== INTEGER_MAX_VALUE && (meta?.capacityControllable ?? false)),
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
  let hasReporting = false;
  const handler = body?.namedChildren.find(n => n.type === 'method_declaration' && childForField(n, 'name')?.text === 'rejectedExecution');
  if (handler) walk(handler, n => {
    if (n.type === 'method_invocation' && (/log|logger|System\.(out|err)|metric|counter|meter|count/i.test(receiverOf(n)?.text ?? '') ||
      ['incrementAndGet', 'addAndGet'].includes(methodNameOf(n)))) hasReporting = true;
  });
  return {
    kind,
    className,
    hasSetName: names.includes('setName'),
    hasReporting,
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

function isCompletableFutureCall(node: JavaSyntaxNode, symbols: JavaSymbols): boolean {
  const receiver = receiverOf(node);
  if (!receiver) return false;
  if (['CompletableFuture', 'java.util.concurrent.CompletableFuture'].includes(receiver.text)) return true;
  if (['CompletableFuture', 'CompletionStage'].includes(baseTypeName(symbols.typeOf(receiver)))) return true;
  return receiver.type === 'method_invocation' && isCompletableFutureCall(receiver, symbols);
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
  const symbolType = state.symbols.typeOf(receiverNode);
  const origin = state.symbols.origin(receiverNode);
  let pool = model.pools.find(p => p.node.id === origin?.id);
  // Explicit static stats(bean) facade for a single compatible bean in this class.
  if (!pool) {
    let parameterReceiver = receiverNode;
    if (parameterReceiver?.type === 'identifier') {
      const local = state.symbols.lookup(parameterReceiver);
      if (local?.value?.type === 'method_invocation' && methodNameOf(local.value) === 'getThreadPoolExecutor') parameterReceiver = receiverOf(local.value);
    }
    const parameter = state.symbols.lookup(parameterReceiver);
    const methodOwner = enclosingMethodOf(node);
    if (parameter?.declaration.type === 'formal_parameter' && /\bstatic\b/.test(methodOwner?.namedChildren.find(n => n.type === 'modifiers')?.text ?? '') &&
        childForField(methodOwner ?? null, 'name')?.text === 'stats') {
      const candidates = model.pools.filter(p => p.isBean && enclosing(p.node, ['class_body'])?.id === enclosing(node, ['class_body'])?.id &&
        (p.kind === 'spring_task_executor' ? /ThreadPoolTaskExecutor/.test(parameter.type) : /ThreadPoolExecutor/.test(parameter.type)));
      if (candidates.length === 1) pool = candidates[0];
    }
  }
  const resolution: ExecutorResolution | 'unresolved' = pool ? 'initializer' : isExecutorType(baseTypeName(symbolType)) ? 'declared' : 'unresolved';
  const tryNode = synchronousTry(node);
  const insideTry = tryNode !== null;
  const caughtTypes = tryNode === null ? [] : caughtTypesOfTry(tryNode);

  if (SUBMIT_METHODS.includes(method) && resolution !== 'unresolved') {
    const task = callArguments(node)[0] ?? null;
    const submit: SubmitFact = {
      method,
      receiver,
      receiverResolution: resolution,
      ...(pool ? { poolId: pool.id } : {}),
      resultHandled: futureResultHandled(node, state.symbols),
      taskExceptionHandled: task !== null && !hasUncaughtThrow(task),
      ...(['scheduleWithFixedDelay','scheduleAtFixedRate'].includes(method) ? {periodicExceptionHandled:periodicExceptionGuard(task,state.symbols)} : {}),
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
  if ((method === 'shutdown' || method === 'shutdownNow' || method === 'awaitTermination') && resolution !== 'unresolved') {
    model.shutdowns.push({ method, receiver, ...(pool ? { poolId: pool.id } : {}), argCount: callArguments(node).length, insideTry, resultUsed, evidence: evidenceOf(node, lines, receiver), node });
  } else if (method === 'close' && resolution !== 'unresolved') {
    model.shutdowns.push({ method: 'close', receiver, ...(pool ? { poolId: pool.id } : {}), argCount: 0, insideTry, resultUsed, evidence: evidenceOf(node, lines, receiver), node });
  }

  if (method === 'get' || method === 'join') {
    const isFutureReceiver =
      /(?:Future|CompletionStage)(?:<|$)/.test(symbolType) ||
      isCompletableFutureCall(node, state.symbols) ||
      (receiverNode !== null && receiverNode.type === 'method_invocation' && SUBMIT_METHODS.includes(methodNameOf(receiverNode)) && isExecutorType(baseTypeName(state.symbols.typeOf(receiverOf(receiverNode)))));
    if (isFutureReceiver) {
      model.futureGets.push({ receiver, hasTimeout: (method === 'get' && callArguments(node).length === 2) || hasFutureTimeout(receiverNode, state.symbols), evidence: evidenceOf(node, lines, receiver) });
    }
  }

  if (/Async$/.test(method) && isCompletableFutureCall(node, state.symbols)) {
    // *Async(supplier) uses the common pool; passing the executor requires a second argument
    // (`supplyAsync(supplier, executor)`, `thenApplyAsync(fn, executor)`, ...).
    const argCount = callArguments(node).length;
    const binary = /^(thenCombine|thenAcceptBoth|runAfterBoth|applyToEither|acceptEither|runAfterEither)Async$/.test(method);
    model.asyncs.push({
      kind: 'completable_future',
      method,
      asynchronous: true,
      hasExplicitExecutor: argCount >= (binary ? 3 : 2),
      evidence: evidenceOf(node, lines, receiver),
    });
  } else if (['thenApply','thenAccept','thenRun','thenCompose','thenCombine','thenAcceptBoth','runAfterBoth',
    'applyToEither','acceptEither','runAfterEither','handle','whenComplete','exceptionally','exceptionallyCompose',
    'complete','completeExceptionally','cancel','completedFuture','failedFuture','allOf','anyOf','orTimeout',
    'completeOnTimeout','toCompletableFuture'].includes(method) && isCompletableFutureCall(node,state.symbols)) {
    model.asyncs.push({kind:'completable_future',method,asynchronous:false,hasExplicitExecutor:false,evidence:evidenceOf(node,lines,receiver)});
  }

  if ((['ofVirtual','startVirtualThread'].includes(method) && ['Thread','java.lang.Thread'].includes(receiverNode?.text ?? '')) ||
      (method === 'newVirtualThreadPerTaskExecutor' && isExecutorsFactory(node))) {
    model.asyncs.push({ kind: 'virtual_thread', method, hasExplicitExecutor: true, evidence: evidenceOf(node, lines, receiver) });
  }

  if (/ThreadLocal/.test(symbolType) && (method === 'set' || method === 'get' || method === 'remove')) {
    model.threadLocals.push({ kind: method, name: receiver, method, inFinally: isInFinally(node), node, ...(state.symbols.lookup(receiverNode) ? { symbolId: state.symbols.lookup(receiverNode)!.id } : {}), evidence: evidenceOf(node, lines, receiver) });
  } else if (receiver === 'MDC' && (method === 'put' || method === 'remove' || method === 'clear')) {
    model.threadLocals.push({
      kind: method === 'put' ? 'set' : 'remove',
      name: 'MDC',
      method,
      inFinally: isInFinally(node),
      node,
      evidence: evidenceOf(node, lines, receiver),
    });
  } else if (method === 'withInitial' && ['ThreadLocal','java.lang.ThreadLocal'].includes(receiverNode?.text ?? '')) {
    model.threadLocals.push({ kind: 'declare', name: receiver, method, inFinally: false, node, evidence: evidenceOf(node, lines, receiver) });
  }

  if (MONITOR_METHODS.includes(method) && resolution !== 'unresolved') {
    model.monitors.push({ method, receiver, ...(pool ? { poolId: pool.id } : {}), evidence: evidenceOf(node, lines, receiver) });
  }

  if (method === 'setUncaughtExceptionHandler' && baseTypeName(symbolType) === 'Thread') model.hasUncaughtExceptionHandler = true;

  applySpringSetter(pool, method, node, lines, state.symbols);
}
/** Attaches `ThreadPoolTaskExecutor` setter calls to the matching pool fact. */
function applySpringSetter(pool: PoolCreationFact | undefined, method: string, node: JavaSyntaxNode, lines: string[], symbols: JavaSymbols): void {
  if (pool === undefined) return;
  const first = callArguments(node)[0];
  if (first === undefined) return;
  switch (method) {
    case 'setWaitForTasksToCompleteOnShutdown':
      pool.waitsForTasksOnShutdown = first.text === 'true';
      break;
    case 'setAwaitTerminationSeconds':
      pool.awaitTerminationSeconds = symbols.integer(first);
      break;
    case 'setCorePoolSize':
      pool.coreSize = resolvedArg(first, symbols);
      break;
    case 'setMaxPoolSize':
    case 'setMaximumPoolSize':
      pool.maxSize = resolvedArg(first, symbols);
      break;
    case 'setKeepAliveSeconds':
    case 'setKeepAliveTime':
      pool.keepAlive = resolvedArg(first, symbols);
      break;
    case 'setQueueCapacity': {
      const capacity = symbols.integer(first);
      pool.queue =
        capacity !== undefined && capacity <= 0
          ? syntheticQueue('SynchronousQueue', 0, evidenceOf(first, lines))
          : {
              typeName: 'LinkedBlockingQueue',
              bounded: capacity !== INTEGER_MAX_VALUE,
              capacityControllable: true,
              reason: 'ThreadPoolTaskExecutor 队列容量由 setQueueCapacity 指定',
              evidence: evidenceOf(first, lines),
              ...(capacity === undefined ? {} : { capacity }),
              capacityText: compactText(first),
            };
      break;
    }
    case 'setThreadNamePrefix':
      pool.threadFactory = { typeName: 'thread-name-prefix', expression: compactText(first), setsName: true, evidence: evidenceOf(first, lines) };
      break;
    case 'setThreadFactory':
      pool.threadFactory = buildThreadFactoryFact(first, lines, symbols);
      break;
    case 'setRejectedExecutionHandler':
      pool.rejection = buildRejectionFact(first, lines);
      break;
    default:
      break;
  }
}

/** `catch (InterruptedException)` must restore the interrupt flag (or rethrow). */
function collectInterruptCatch(node: JavaSyntaxNode, lines: string[], model: JavaThreadPoolModel, symbols: JavaSymbols): void {
  const parameter = node.namedChildren.find((child) => child.type === 'catch_formal_parameter');
  if (parameter === undefined) return;
  const catchType = parameter.namedChildren.find((child) => child.type === 'catch_type');
  if (!(catchType?.text ?? '').split('|').some(t => lastIdentifier(t) === 'InterruptedException')) return;
  model.interruptCatches.push({
    restored: interruptRestored(node,symbols),
    variableName: childForField(parameter, 'name')?.text ?? '',
    evidence: evidenceOf(node, lines),
  });
}

function resolvedArg(node: JavaSyntaxNode, symbols: JavaSymbols): ArgFact {
  const fact = argFact(node);
  const value = symbols.integer(node);
  if (value !== undefined) fact.number = value;
  return fact;
}

/** A try outside a lambda/method cannot catch an exception raised later on a worker. */
function synchronousTry(node: JavaSyntaxNode): JavaSyntaxNode | null {
  for (let current = node.parent; current; current = current.parent) {
    if (['lambda_expression', 'method_declaration', 'constructor_declaration'].includes(current.type)) return null;
    if (['try_statement', 'try_with_resources_statement'].includes(current.type)) {
      const body = childForField(current, 'body');
      if (body && node.startIndex >= body.startIndex && node.endIndex <= body.endIndex) return current;
    }
  }
  return null;
}
/** Conservative structural guard: inline/aliased lambda or one unambiguous private helper. */
function periodicExceptionGuard(task: JavaSyntaxNode | null,symbols: JavaSymbols): boolean {
  if(!task)return false;
  const origin=symbols.origin(task)??task;
  if(origin.type!=='lambda_expression')return false;
  let body=childForField(origin,'body');
  const call=body?.type==='method_invocation'?body:body?.type==='block'&&body.namedChildren.length===1&&body.namedChildren[0]?.type==='expression_statement'
    ? body.namedChildren[0].namedChildren[0] : undefined;
  if(call?.type==='method_invocation'){
    const helper=symbols.method(call);
    // Argument evaluation occurs before entering the helper's protected try body.
    const simpleArguments=callArguments(call).every(arg=>arg.type==='identifier'||arg.type.endsWith('_literal'));
    if(helper && simpleArguments && /\bprivate\b/.test(helper.namedChildren.find(n=>n.type==='modifiers')?.text??''))body=childForField(helper,'body');
  }
  if(body?.type!=='block'||body.namedChildren.length!==1)return false;
  const guard=body.namedChildren[0]!;
  if(guard.type!=='try_statement'||!caughtTypesOfTry(guard).some(t=>['RuntimeException','Exception','Throwable'].includes(t)))return false;
  // A catch/finally that explicitly rethrows still terminates future executions.
  return guard.namedChildren.filter(n=>['catch_clause','finally_clause'].includes(n.type)).every(clause=>!containsThrowStatement(clause));
}
function hasUncaughtThrow(task: JavaSyntaxNode): boolean {
  let uncaught = false;
  walk(task, node => {
    if (node.type !== 'throw_statement') return;
    const caught = synchronousTry(node);
    const thrown = node.namedChildren[0];
    const type = thrown?.type === 'object_creation_expression' ? typeNameOf(thrown) : '';
    const runtime = /^(IllegalStateException|IllegalArgumentException|NullPointerException|ArithmeticException|RejectedExecutionException|RuntimeException)$/.test(type);
    if (!caught || !caughtTypesOfTry(caught).some(t => t === 'Throwable' || t === type || (t === 'Exception' && /Exception$/.test(type)) || (t === 'RuntimeException' && runtime))) uncaught = true;
  });
  return uncaught;
}
function futureResultHandled(node: JavaSyntaxNode, symbols: JavaSymbols): boolean {
  if (node.parent?.type === 'return_statement' || node.parent?.type === 'argument_list') return true;
  if (node.parent?.type === 'method_invocation') return ['get', 'join'].includes(methodNameOf(node.parent));
  const declaration = node.parent?.type === 'variable_declarator' ? node.parent : undefined;
  if (!declaration) return false;
  const symbol = symbols.symbols.find(s => s.id === declaration.id);
  if (!symbol) return false;
  return symbols.nodes.some(n => {
    if (n.startIndex <= node.startIndex || !['method_invocation', 'identifier'].includes(n.type)) return false;
    if (n.type === 'method_invocation') return ['get', 'join'].includes(methodNameOf(n)) && symbols.lookup(receiverOf(n))?.id === symbol.id;
    return ['return_statement', 'argument_list'].includes(n.parent?.type ?? '') && symbols.lookup(n)?.id === symbol.id;
  });
}
function hasFutureTimeout(expression: JavaSyntaxNode | null, symbols: JavaSymbols, seen = new Set<number>()): boolean {
  if (!expression || seen.has(expression.id)) return false;
  seen.add(expression.id);
  if (expression.type === 'method_invocation') {
    if (['orTimeout', 'completeOnTimeout'].includes(methodNameOf(expression))) return true;
    return hasFutureTimeout(receiverOf(expression), symbols, seen);
  }
  const symbol = symbols.lookup(expression);
  if (!symbol) return false;
  if (hasFutureTimeout(symbol.value, symbols, seen)) return true;
  return symbols.nodes.some(n => n.type === 'method_invocation' && ['orTimeout', 'completeOnTimeout'].includes(methodNameOf(n)) &&
    n.startIndex < expression.startIndex && symbols.lookup(receiverOf(n))?.id === symbol.id);
}


/** Follow bean return values as well as inline creation; avoid duplicate/manual close owners. */
function attachContainerOwnership(symbols: JavaSymbols, model: JavaThreadPoolModel): void {
  for (const method of symbols.nodes.filter(n => n.type === 'method_declaration' && methodAnnotationsOf(n).includes('Bean'))) {
    const returns = symbols.nodes.filter(n => n.type === 'return_statement' && enclosingMethodOf(n)?.id === method.id);
    for (const returned of returns) {
      const origin = symbols.origin(returned.namedChildren[0] ?? null);
      const pool = model.pools.find(p => p.node.id === origin?.id);
      if (!pool) continue;
      pool.isBean = true;
      pool.containerManaged = !/destroyMethod\s*=\s*""/.test(method.namedChildren.find(n => n.type === 'modifiers')?.text ?? '');
    }
  }
}
