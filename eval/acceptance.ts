/** Task completion is evidence-based review, separate from deterministic rules. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';

export const TASK_CRITERIA: Record<string, readonly string[]> = {
  'CASE-001': ['订单通知确实在异步执行路径发生', '下游通知失败不影响下单主流程'],
  'CASE-002': ['订单同步任务实际执行且异常可见', '复用工作线程时租户上下文不串数据'],
  'CASE-003': ['导出请求能够被执行', '过载时队列内存有界且拒绝行为明确'],
  'CASE-004': ['失败订单会被周期性重试', '一次重试异常不会永久中止后续调度'],
  'CASE-005': ['高峰时线程数能扩容', '空闲后非核心线程可以回收'],
  'CASE-006': ['高优先级任务先于低优先级任务执行', '过载淘汰最旧任务且不误删最高优先级任务'],
  'CASE-007': ['日志异步写入', '过载丢弃有计数并有可观测告警'],
  'CASE-008': ['库存同步实际执行', '拒绝时调用侧执行可验证的补偿'],
  'CASE-009': ['自定义拒绝路径留有日志或持久记录', '拒绝次数可被监控统计'],
  'CASE-010': ['文件处理实际执行', '实际工作线程名可识别文件处理业务'],
  'CASE-011': ['连续事件都能被推送', '多次调用复用同一个业务线程池'],
  'CASE-012': ['异步返回正确报价', '阻塞下游在业务线程池运行且等待有超时'],
  'CASE-013': ['关闭时已接受的队列任务被处理', '关闭方法等待任务完成后返回'],
  'CASE-014': ['关闭流程响应中断', '捕获中断后恢复中断标志'],
  'CASE-015': ['强制关闭时未执行任务被记录或补偿', '正常关闭与中断路径都不静默丢弃待执行任务'],
  'CASE-016': ['真实 Spring 容器可创建和销毁线程池 Bean', '线程池有可读取的监控出口'],
  'CASE-017': ['阻塞通知在虚拟线程执行', '并发访问下游有实际限流上限'],
  'CASE-018': ['结算执行与重试调度使用独立线程池', '两个线程池都有监控和关闭流程'],
  'CASE-019': ['金额求和与 VIP 折扣保持正确', '纯金额业务不引入线程池'],
  'CASE-020': ['CompletableFuture 编排返回正确导出结果', '线程上下文在正常和异常路径都得到清理', '超时取消及关闭路径有效'],
  'CASE-021': ['真实 Spring 容器关闭时回收裸线程池', '通知任务异常可见且不杀死后续任务处理'],
};

export function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function acceptanceTest(caseId: string): { testSource: string; testClass: string; testArgs?: string[] } | undefined {
  if (['CASE-004', 'CASE-006', 'CASE-012', 'CASE-017', 'CASE-019', 'CASE-020'].includes(caseId)) return { testSource: resolve(REPOSITORY_ROOT, 'eval', 'acceptance', `${caseId}.java`), testClass: 'AcceptanceTest' };
  if (TASK_CRITERIA[caseId]) {
    return { testSource: resolve(REPOSITORY_ROOT, 'eval', 'acceptance', 'RuntimeAcceptance.java'), testClass: 'RuntimeAcceptance', testArgs: [caseId] };
  }
  return undefined;
}

/** Independent diagnostics when an earlier assertion would hide another scenario. */
export function acceptanceScenarios(caseId:string): string[] {
  if(caseId==='CASE-004')return ['failure-isolation','fixed-delay','pending-shutdown','running-shutdown','interrupted-shutdown'];
  if(caseId==='CASE-020')return ['queued-shutdown','uninterruptible-shutdown'];
  return [];
}

export interface TaskReview {
  source_sha256: string;
  reviewer: string;
  criteria: Array<{ criterion: string; passed: boolean | null; verdict?: 'unverifiable'; evidence: string }>;
}
export function readTaskReview(file: string, source: string, caseId: string): { status: 'ok' | 'failed' | 'not_run'; detail: string } {
  if (!existsSync(file)) return { status: 'not_run', detail: 'Task review is missing.' };
  try {
    const review = JSON.parse(readFileSync(file, 'utf8')) as TaskReview;
    const expected = TASK_CRITERIA[caseId];
    if (!expected || review.source_sha256 !== sha256(source) || !review.reviewer?.trim() || !Array.isArray(review.criteria) ||
      review.criteria.length !== expected.length || expected.some(criterion => review.criteria.filter(c => c.criterion === criterion && (typeof c.passed === 'boolean' || c.passed === null && c.verdict === 'unverifiable') && c.evidence?.trim()).length !== 1)) {
      return { status: 'not_run', detail: 'Invalid, incomplete or stale task review.' };
    }
    const failed = review.criteria.filter(c => c.passed === false);
    const unresolved = review.criteria.filter(c => c.passed === null);
    if (failed.length === 0 && unresolved.length > 0) return { status: 'not_run', detail: `Reviewed by ${review.reviewer}; evidence insufficient for task completion:\n` + unresolved.map(c => `${c.criterion}: ${c.evidence}`).join('\n').slice(0, 8000) };
    return { status: failed.length ? 'failed' : 'ok', detail: `Reviewed by ${review.reviewer}` +
      (failed.length ? '\n' + failed.map(c => `${c.criterion}: ${c.evidence}`).join('\n').slice(0, 8000) : '') };
  } catch { return { status: 'not_run', detail: 'Cannot parse task review.' }; }
}
