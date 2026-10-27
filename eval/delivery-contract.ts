/** Test adapters are scoped to each task, never injected as unrelated business requirements. */
import { observableContract } from './business-contracts.ts';
import type { EvaluationCase } from './cases.ts';

const ADAPTERS: Record<string, readonly string[]> = {
  'CASE-001': ['订单输入类型为 com.example.order.domain.Order(String id, String tenantId)。'],
  'CASE-002': ['订单输入类型为 com.example.order.domain.Order(String id, String tenantId)；保留已有 TENANT 上下文字段。'],
  'CASE-004': ['保留公开无参构造和 scheduleRetry(String)，增加公开 RetryScheduler(long initialDelayMillis, long delayMillis, java.util.function.Consumer<String> retryHandler) 构造器。初始延迟非负，固定延迟严格为正，注入回调非 null；单位均为毫秒。回调在实例 ScheduledThreadPoolExecutor 工作线程执行，每次接收原始 orderId，同一注册使用 scheduleWithFixedDelay：上一轮执行完成后再等待指定延迟，不重叠且不追赶补跑。回调抛 RuntimeException 须记录且后续周期仍执行，不影响其他订单。无参构造没有配置真实下游时 scheduleRetry 明确抛 IllegalStateException，不以空方法或日志冒充业务重试。保留 stats() 监控及 stop() 生命周期入口；关闭取消未开始的延迟注册，不再发起后续周期，等待已运行回调完成，宽限 200ms 后可强制中断，再有界等待终止；无法终止时向调用方报错，捕获中断后保留标志。关闭后 scheduleRetry 同步抛 RejectedExecutionException（不是 IllegalStateException），并将订单保存在 Queue<String> pendingRetries 中供补偿观察；包括与 stop 并发时 execute/schedule 被拒绝的路径。无参未配置状态与公开三参构造的非空校验须分开实现：无参可使用独立初始化或私有构造路径，但不得为兼容无参而允许调用者向公开三参构造传 null。ScheduledThreadPoolExecutor 的 DelayedWorkQueue 仍是无界队列，removeOnCancelPolicy 不是容量上限，不得在注释中声称已经使用了有界队列。'],
  'CASE-006': ['保留 dispatch(String)，默认优先级为 0；增加 dispatch(String, int priority)，数值越大越优先，同级按提交顺序 FIFO。增加公开 UrgentTaskDispatcher(java.util.function.Consumer<String> handler) 构造器，接入实际任务处理；保留公开无参构造。队列有界，满载时原子地淘汰最低优先级中最旧且优先级不高于新任务的排队任务，再接收新任务；若所有排队任务都更重要则明确抛出 RejectedExecutionException，不允许淘汰它们。淘汰、拒绝和任务异常需要可观测。允许当前正在执行的任务完成，优先级只约束仍在排队的任务。不得通过任务 ID 猜测优先级。验收同时使用原始生产线程池参数：禁止队列满时扩容非核心线程执行低优先级新任务以绕过拒绝；可固定 core=max 或实现等效的严格准入控制。'],
  'CASE-007': ['通过无参 stats() 暴露运行及拒绝统计。'],
  'CASE-008': ['本 PoC 使用名为 retryQueue 的 Collection 字段保留被拒绝的 SKU，供补偿验收读取。'],
  'CASE-009': ['通过无参 stats() 暴露拒绝统计，保留 dispatch(String) 调用入口。'],
  'CASE-012': ['正常报价结果保持 quote- 加 orderId；本 PoC 的等待上限为 2 秒，超时以 TimeoutException 异常完成 Future；调用方法本身须及时返回。'],
  'CASE-015': ['本 PoC 使用名为 fallbackQueue 的 Collection<Runnable> 字段保留强制关闭时未执行的任务。'],
  'CASE-016': ['Spring 线程池 Bean 名保持 orderNotifier；保留公开无参构造和 orderNotifier() 签名；监控入口为 stats() 或静态 stats(bean)。验收只注册当前配置类启动独立 Spring context，没有 Spring Boot 自动配置；使用 MeterRegistry 等依赖时须在本类提供真实 Bean 或自行初始化。'],
  'CASE-017': ['保留公开无参构造及 notify(String)；增加公开 LoomNotifier(int maxConcurrent, java.util.function.Consumer<String> downstream) 构造器以注入真实下游。实际回调必须在虚拟线程执行，notify 在下游阻塞时也须及时返回。并发上限在每个实例内生效，提交前快速准入；已满或关闭时同步抛 RejectedExecutionException，不能创建无限等待任务或静默丢弃。正常完成、下游异常、工作线程中断以及启动失败均释放已获取许可；回调异常需要记录且不能阻断后续通知。stats() 返回 Map<String,Long>，提供 active（已接受未结束）、completed（成功）、failed（回调失败）、rejected（每个拒绝请求计一次）。stop() 停止接收并等待已接收通知结束，超时/中断须明确报告；保留调用方中断标志，不在调用线程降级执行下游。'],
  'CASE-019': ['保留 OrderItem record 和 total(List<OrderItem>, boolean) 的金额与 VIP 折扣行为。'],
  'CASE-020': ['保留 TENANT、公开无参构造、export(String) 返回 report- 加 reportId、stats() 和 stop()；增加公开 ExportOrchestrator(long timeoutMillis, java.util.function.Function<String,String> generator) 构造器，注入实际导出和等待超时。默认超时 30 秒。真实回调必须在可观察的实例业务 ThreadPoolExecutor 上执行，回调内 TENANT=tenant- 加 reportId；正常、异常、超时、调用者中断、拒绝及关闭都恢复调用者和工作线程原上下文。超时或中断需取消实际执行任务并中断可中断的回调，不能仅取消 CompletableFuture 完成状态；保留原始异常原因及调用者中断标志。排队超时应移除已取消任务，过载或关闭时同步拒绝并将 reportId 保存到 Queue<String> pendingReports。stop() 停止准入；PoC 宽限等待为 200ms，随后强制关闭，取消未启动和在执行的任务，使等待结果的调用者及时结束；不响应中断时明确报告失败。每次 stop 都等待关闭完成，包括重复/并发调用。用 CompletableFuture 编排结果，但保留独立 FutureTask 或等价可取消执行句柄；CompletableFuture.cancel(true) 不会中断执行线程。'],
  'CASE-021': ['Spring 线程池 Bean 名保持 orderNotifier。'],
};

export function deliveryContract(testCase: Pick<EvaluationCase, 'id'>, businessContractVersion: 1 | 2 = 1): string {
  const adapters = [...(ADAPTERS[testCase.id] ?? []), ...(businessContractVersion === 2 ? observableContract(testCase.id) : [])];
  return `\n\n## 实验交付约定（三种策略相同）
返回完整的单个 Java 源文件，保留当前类名和公开方法签名，完成原始任务；不添加当前任务之外的业务功能。
补齐片段中省略的必要成员与业务实现，不用空方法替代任务。使用 Java 21，返回源码，不输出解释文本。
如服务持有 ExecutorService，保留可反射观察的实例字段，便于隔离测试；不要为没有并发需求的任务额外创建线程池。
可用 classpath：JDK 21、Spring 6.2.11、Micrometer Core/Observation/Commons 1.14.11、Jakarta Annotation 2.1.1、SLF4J API/Simple 2.0.17。仅在任务需要时使用；不得假定其他依赖存在。
日志使用 JDK 日志或已配置的 SLF4J，并定义实际 logger 成员。${adapters.length ? '\n当前用例的测试接口约定：\n' + adapters.join('\n') : ''}
评测仅允许提取单个 Java 代码块，不修复源码、不补桩。编译、功能、规则和任务验收分别统计。`;
}
