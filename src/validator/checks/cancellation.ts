/** File-local cancellation identity checks; no cross-method or runtime cancellation proof. */
import { callArguments, childForField, methodNameOf, receiverOf, typeNameOf } from '../../analyzer/ast-utils.ts';
import { JavaSymbols, enclosing, isWithin } from '../../analyzer/java-symbols.ts';
import type { JavaSyntaxNode } from '../../analyzer/java-parser.ts';
import type { CheckContext, CheckFinding } from '../validator-registry.ts';

const BOUNDARIES = ['method_declaration', 'constructor_declaration', 'lambda_expression'];

export function cancelledQueueFindings(ctx: CheckContext): CheckFinding[] {
  const symbols = new JavaSymbols(ctx.parsed.rootNode);
  const calls = symbols.nodes.filter(n => n.type === 'method_invocation');
  const findings: CheckFinding[] = [];
  for (const cancel of calls.filter(n => methodNameOf(n) === 'cancel')) {
    const task = symbols.origin(receiverOf(cancel));
    if (!task || task.type !== 'object_creation_expression' || typeNameOf(task) !== 'FutureTask') continue;
    const boundary = enclosing(cancel, BOUNDARIES);
    const submissions = ctx.model.submits.filter(s => s.method === 'execute' &&
      enclosing(s.node, BOUNDARIES)?.id === boundary?.id && s.node.startIndex < cancel.startIndex &&
      ctx.model.pools.some(p => p.id === s.poolId && p.kind === 'thread_pool_executor'));
    for (const submit of submissions) {
      const rejected = enclosing(cancel, ['catch_clause']);
      const rejectedBody = rejected?.parent && childForField(rejected.parent, 'body');
      // AbortPolicy rejection means this execute did not accept the task into its queue.
      if (rejected && /\bRejectedExecutionException\b/.test(childForField(rejected, 'parameter')?.text ?? rejected.namedChildren[0]?.text ?? '') &&
        rejectedBody && isWithin(submit.node, rejectedBody) &&
        ctx.model.pools.some(p => p.id === submit.poolId && p.rejection?.kind === 'abort')) continue;
      const argument = callArguments(submit.node)[0] ?? null;
      const queued = symbols.origin(argument);
      const direct = queued?.id === task.id;
      const wrapper = queued?.type === 'lambda_expression' && calls.some(c => isWithin(c, queued) &&
        methodNameOf(c) === 'run' && symbols.origin(receiverOf(c))?.id === task.id);
      if (!direct && !wrapper) continue;
      const pool = symbols.origin(receiverOf(submit.node));
      if (!pool) continue;
      const cleanups = calls.filter(c => symbols.origin(receiverOf(c))?.id === pool.id &&
        enclosing(c, BOUNDARIES)?.id === boundary?.id);
      const cleansIdentity = (c: JavaSyntaxNode): boolean => {
        if (methodNameOf(c) === 'purge') return direct; // A lambda wrapper is not the cancelled Future.
        return methodNameOf(c) === 'remove' && symbols.origin(callArguments(c)[0] ?? null)?.id === queued?.id;
      };
      // Recognize unconditional cleanup in this block, or the corresponding try's finally.
      const block = enclosing(cancel, ['block']);
      const caught = enclosing(cancel, ['catch_clause']);
      const final = caught?.parent?.namedChildren.find(n => n.type === 'finally_clause');
      const finalBody = final?.namedChildren.find(n => n.type === 'block');
      const guaranteed = cleanups.some(c => cleansIdentity(c) && c.parent?.type === 'expression_statement' &&
        ((c.parent.parent?.id === block?.id && c.startIndex > cancel.endIndex &&
          !block?.namedChildren.some(n => n.startIndex > cancel.endIndex && n.endIndex < c.startIndex &&
            ['return_statement', 'throw_statement', 'if_statement', 'try_statement'].includes(n.type))) ||
          c.parent.parent?.id === finalBody?.id));
      if (guaranteed) continue;
      const wrongRemoval = wrapper && cleanups.some(c => methodNameOf(c) === 'remove' &&
        symbols.origin(callArguments(c)[0] ?? null)?.id === task.id);
      findings.push({
        message: wrongRemoval
          ? '取消的是内部 FutureTask，但 execute 入队的是 lambda 包装器；remove(task) 与实际入队对象不同，不能释放该排队项。'
          : 'FutureTask.cancel() 不会自动移除 ThreadPoolExecutor 中的排队项；未确认该取消路径按实际入队对象 remove 或有效 purge，存在容量滞留风险。',
        suggestion: '保留实际入队的 Runnable 身份，取消后在对应路径 remove(queuedRunnable)；直接 execute(task) 时可 remove(task) 或 purge()。跨方法清理、协作取消和运行中任务仍需源码审查及队列饱和测试。',
        line: cancel.startPosition.row + 1, column: cancel.startPosition.column + 1,
        snippet: cancel.text,
      });
      break;
    }
  }
  return findings;
}
