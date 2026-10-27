/**
 * Structured "facts" extracted from Java source. Semantic features and rule
 * checkers are both derived from this model, so that the (expensive) AST walk
 * happens exactly once per analysis.
 */
import type { Evidence } from '../domain/types.ts';
import type { JavaParseError, JavaSyntaxNode } from './java-parser.ts';

export type PoolKind =
  | 'thread_pool_executor'
  | 'scheduled_thread_pool_executor'
  | 'executors_factory'
  | 'spring_task_executor'
  | 'virtual_thread_executor'
  | 'thread_per_task_executor';

export type PoolScope = 'field' | 'static_field' | 'local' | 'expression' | 'bean_method';

/** One constructor / method argument, kept as text plus an optional numeric value. */
export interface ArgFact {
  text: string;
  /** Parsed integer value for literals and `Integer.MAX_VALUE`. */
  number?: number;
  isNull: boolean;
  nodeType: string;
}

export interface QueueFact {
  typeName: string;
  capacityText?: string;
  capacity?: number;
  bounded: boolean;
  /** True when the queue capacity can be set through a constructor argument. */
  capacityControllable: boolean;
  reason: string;
  evidence: Evidence;
}

export type RejectionKind = 'abort' | 'caller_runs' | 'discard' | 'discard_oldest' | 'custom' | 'unknown';

export interface RejectionFact {
  typeName: string;
  kind: RejectionKind;
  evidence: Evidence;
}

export interface ThreadFactoryFact {
  typeName: string;
  expression: string;
  handlesExceptions?: boolean;
  evidence: Evidence;
  /** True when the factory implementation is in this file and calls `setName`. */
  setsName?: boolean;
}

export interface PoolCreationFact {
  id: string;
  kind: PoolKind;
  /** `Executors.newFixedThreadPool` for factory based pools. */
  factoryMethod?: string;
  variableName?: string;
  declaredType?: string;
  scope: PoolScope;
  modifiers: string[];
  /** True when the pool is created inside an `@Bean` method. */
  isBean: boolean;
  /** True when the actual bean definition has a container destruction path. */
  containerManaged?: boolean;
  waitsForTasksOnShutdown?: boolean;
  awaitTerminationSeconds?: number;
  /** True when the file contains a `@PreDestroy` method. */
  hasPreDestroy: boolean;
  isScheduled: boolean;
  argCount: number;
  coreSize?: ArgFact;
  maxSize?: ArgFact;
  keepAlive?: ArgFact;
  timeUnit?: string;
  queue?: QueueFact;
  threadFactory?: ThreadFactoryFact;
  rejection?: RejectionFact;
  evidence: Evidence;
  node: JavaSyntaxNode;
}

export type ExecutorResolution = 'declared' | 'initializer' | 'heuristic';

export interface ExecutorRefFact {
  name: string;
  declaredType: string;
  resolution: ExecutorResolution;
  evidence: Evidence;
}

export interface SubmitFact {
  method: string;
  receiver: string;
  receiverResolution: ExecutorResolution | 'unresolved';
  /** False when the call is a bare statement, i.e. the Future is discarded. */
  resultUsed: boolean;
  /** Actual consumption/escape of the returned Future, not merely assignment. */
  resultHandled: boolean;
  poolId?: string;
  taskExceptionHandled: boolean;
  /** Visible whole-body RuntimeException guard for a recurring task; unknown bodies remain false. */
  periodicExceptionHandled?: boolean;
  insideTry: boolean;
  caughtTypes: string[];
  /** The submitted task body throws an exception itself. */
  taskThrows: boolean;
  evidence: Evidence;
  node: JavaSyntaxNode;
}

export type ShutdownMethod = 'shutdown' | 'shutdownNow' | 'close' | 'awaitTermination';

export interface ShutdownFact {
  poolId?: string;
  method: ShutdownMethod;
  receiver: string;
  argCount: number;
  insideTry: boolean;
  /** False when the call is a bare statement (relevant for shutdownNow / close). */
  resultUsed: boolean;
  evidence: Evidence;
  node: JavaSyntaxNode;
}

export interface FutureGetFact {
  receiver: string;
  hasTimeout: boolean;
  evidence: Evidence;
}

export interface AsyncFact {
  kind: 'completable_future' | 'virtual_thread';
  method: string;
  /** False for synchronous CompletableFuture composition/completion operations. */
  asynchronous?: boolean;
  hasExplicitExecutor: boolean;
  evidence: Evidence;
}

export interface ThreadLocalFact {
  kind: 'declare' | 'set' | 'get' | 'remove';
  name: string;
  method?: string;
  inFinally: boolean;
  node: JavaSyntaxNode;
  symbolId?: number;
  evidence: Evidence;
}

export interface MonitorFact {
  poolId?: string;
  method: string;
  receiver: string;
  evidence: Evidence;
}

export interface CustomImplFact {
  kind: 'thread_factory' | 'rejection_handler';
  className: string;
  hasSetName: boolean;
  hasReporting: boolean;
  evidence: Evidence;
}

export interface InterruptCatchFact {
  /** `Thread.currentThread().interrupt()` called, or the exception is rethrown. */
  restored: boolean;
  variableName: string;
  evidence: Evidence;
}

export interface JavaThreadPoolModel {
  filePath: string;
  packageName: string;
  imports: string[];
  classNames: string[];
  parseErrors: JavaParseError[];
  pools: PoolCreationFact[];
  executors: ExecutorRefFact[];
  submits: SubmitFact[];
  shutdowns: ShutdownFact[];
  futureGets: FutureGetFact[];
  asyncs: AsyncFact[];
  threadLocals: ThreadLocalFact[];
  monitors: MonitorFact[];
  customImpls: CustomImplFact[];
  interruptCatches: InterruptCatchFact[];
  /** Method / class level annotations, without the `@` prefix. */
  annotations: string[];
  hasUncaughtExceptionHandler: boolean;
  /** True when the file declares a `@PreDestroy` method. */
  hasPreDestroy: boolean;
  /** True when at least one pool is exposed by an `@Bean` method. */
  hasBeanManagedPool: boolean;
}
