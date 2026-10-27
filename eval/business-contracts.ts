/** Opt-in v2 contracts: explicit observable boundaries, never retroactive on v1 runs. */
export const OBSERVABLE_CASES = ['CASE-001','CASE-002','CASE-003','CASE-007','CASE-008','CASE-010','CASE-011'] as const;
export function observableContract(caseId: string): string[] {
  if (!(OBSERVABLE_CASES as readonly string[]).includes(caseId)) return [];
  const specifics: Record<string,string> = {
    'CASE-001':'增加公开 OrderAsyncService(java.util.function.Consumer<com.example.order.domain.Order> sender) 构造器，notifyCreated 把原始 Order 传给 sender。',
    'CASE-002':'增加公开 OrderSyncService(java.util.function.Consumer<com.example.order.domain.Order> synchronizer, java.util.function.Function<String,com.example.order.domain.Order> loader) 构造器。syncCreated 传原始 Order，回调内 TENANT=order.tenantId，finally 恢复工作线程原值（原来无值则 remove）。reload 在业务线程池调用 loader，使用带超时的 Future 等待并返回 loader 原始结果，超时/调用者中断取消实际任务并保留异常原因和中断状态。',
    'CASE-003':'增加公开 ReportExportService(java.util.function.Consumer<String> exporter) 构造器；export 将原始 reportId 交给 exporter。',
    'CASE-007':'增加公开 AsyncLogWriter(java.util.function.Consumer<String> sink) 构造器；write 将原始日志消息交给 sink，不以额外打一条日志替代该 sink。',
    'CASE-008':'增加公开 InventorySyncService(java.util.function.Consumer<String> synchronizer) 构造器；sync 将原始 SKU 交给 synchronizer；拒绝时仍将 SKU 放入 retryQueue 供补偿观察。',
    'CASE-010':'增加公开 FileProcessService(java.util.function.Consumer<String> handler) 构造器；process 将原始 fileId 交给 handler，实际工作线程名保留 file-process 业务前缀。',
    'CASE-011':'增加公开 RealtimePushHandler(java.util.function.Consumer<String> receiver) 构造器；onEvent 将原始 eventId 交给 receiver，连续调用复用同一个实例线程池。',
  };
  return [specifics[caseId]!, '以上回调是本轮明确的可观察业务边界，不要求实际外网服务。保留原公开无参构造及方法；公开配置构造拒绝 null。无参未配置下游时业务入口同步抛 IllegalStateException，不用空方法或日志伪装业务成功。',
    '业务回调在可观察的实例 ThreadPoolExecutor 工作线程执行；有界队列，原入口异步返回，不在提交线程降级运行回调。回调 RuntimeException 计数且记录日志，不传播到原提交调用者，不阻断后续任务。调用线程原有上下文不变；CASE-002 还须恢复工作线程 TENANT。',
    '提供无参 stats() 返回 Map<String,Long>，包含 submitted（异步入口成功接收）、completed（回调成功）、failed（回调失败）、rejected（饱和或关闭拒绝）；每次入口任务各记一次，reload 不纳入这四项异步入口统计。饱和/关闭时同步抛 RejectedExecutionException 并记录拒绝；CASE-008 同时补偿 SKU。',
    '提供 stop()：停止准入，并等待已接受任务完成；200ms 宽限后可强制关闭，处理未执行任务并再次有界等待，不能终止时明确报错，保留调用者中断标志。关闭后入口明确拒绝。'];
}
