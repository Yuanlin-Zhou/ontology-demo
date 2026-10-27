# CASE-020：导出超时、实际取消与上下文恢复

## 问题与修复

旧的 CASE-020 运行验收只检查正常返回及调用/工作线程上下文，没有验证超时、中断、排队取消、拒绝或强制关闭。原始供参考的 before.java 使用 CompletableFuture.supplyAsync，超时时只调用 future.cancel(true)。Java 21 探针已确认：这只取消完成状态，不会把中断送到执行线程；orTimeout 同样不停止底层计算。

新增可编译 good.java，保留 export(String)、stats()、stop() 和无参构造；用 ExportOrchestrator(long timeoutMillis, Function<String,String> generator) 注入真实导出回调与超时，默认仍返回 report- 加 reportId。CompletableFuture 编排结果；FutureTask 持有实际执行与取消责任，取消时同时移除队列中的对应任务。

调用方在 try/finally 中保存/恢复原上下文；工作线程设置 tenant- 加 reportId，并在 finally 恢复已有值，不能简单 remove 掉调用者已有上下文。超时保留 TimeoutException 原因，中断保留 InterruptedException 和中断标志，导出异常保留原始原因。

stop 在同一生命周期锁下关闭准入，等待 200ms 后强制关闭，取消尚未完成的 FutureTask，使尚未启动的排队导出也结束等待。FutureTask.done 将取消传播到结果；只丢弃 shutdownNow 返回的队列对象会遗留等待结果的调用方。每次 stop 均等待终止，重复/并发调用也不提前返回。回调不响应中断时，等待有界并报告未终止，不宣称取消标记等于工作已结束。

## 验收与反例

新增独立 `eval/acceptance/CASE-020.java`：

- 默认结果与注入回调的实际结果；回调运行在业务工作线程。
- 正常、异常、超时、中断时恢复原调用上下文；同时覆盖初始为空与已有值的调用者。
- 工作线程复用前后保留 worker-before，上下文不只检查 null。
- 超时及调用者中断后，可中断的真实阻塞回调收到中断并退出，随后工作线程可复用。
- 排队超时移除任务，释放队列容量，回调不延后执行。
- 满载拒绝及 pendingReports 补偿；关闭后拒绝且不泄漏调用者上下文。
- 强制关闭取消排队结果，调用方及时结束；正常及重复关闭等待已接受任务完成。

初始八个可编译反例分别只取消 CompletableFuture、保留取消队列项、漏恢复工作线程上下文、漏恢复调用者上下文、强制关闭不完成排队结果、吞掉调用者中断、重复关闭提前返回、丢失原始异常原因。每份反例都必须先通过 javac，再由运行断言拒绝。定向回归通过，日志 `/tmp/export-targeted-tests.log`。

旧的上下文轻量探针只在既有上下文单元回归中显式使用；正式 CASE-020 路由已指向新的完整行为验收。

## 引擎优化

参考实现还揭示特征识别缺口：引擎此前只识别 *Async，漏了手动完成和 thenApply 等同步编排。现识别真实 CompletableFuture/CompletionStage 类型上的同步编排/完成，事实与特征证据增加 asynchronous=false；TP-SUBMIT-003 仅对真正的 *Async 方法要求显式 Executor。类型匹配收紧为实际类型名，避免 CompletableFutureView 之类业务类型误触发。

对应正反例验证同步编排被识别但不误报 Executor，改为 thenApplyAsync 后仍正确要求 Executor。知识中的等待超时建议也补充实际取消句柄、协作中断及队列回收，未新增一个只看 cancel 文本就认定取消成功的 checker。

## 证据边界

参考实现与验收建设阶段 **0 次模型调用**，没有重生成或手改历史模型源码，没有改写首次比较报告。新增参考实现、任务接口约定与验收不能回填旧实验成功率。运行检查使用注入回调，不能证明未提供的真实 HTTP/SQL 下游一定响应中断，或任意分支下的取消逻辑都正确。

CASE-020 继续要求绑定源码哈希的任务审查：运行测试不能单独证明实际结果确实由 CompletableFuture 编排，不能把仅出现类型名当作架构正确。参考实现的结果创建、FutureTask 完成/取消、thenApply 与 get 链路另有源码审查证据。通用修复适配器不会仅因这些局部运行测试通过就自动宣布 CASE-020 完整任务完成。

Phase 1 尚未整体验收；其他用例的下游业务执行、异常与关闭证据仍需逐项补齐。

## 最终验证

先完成全量 **128/128 通过、0 跳过**，日志 `/tmp/export-verified-tests.log`；收尾保留原有 Jakarta PreDestroy 注解后，导出正例及八个可编译反例再次全部通过，日志 `/tmp/export-lifecycle-verified-tests.log`。配置使用真实 Java 21 与固定依赖，未延长检查超时。当前参考源码通过 24 条适用检查、0 违规，公开接口结构检查、TypeScript 类型检查及 git diff --check 均通过。

绑定源码哈希的 Agent 任务审查为 `.eval-cache/export-reference-task-review.json`；静态/公开 API 证据为 `export-static-verification.json`。good.java 是本轮手写参考实现，不是模型产出，不能将其通过计算为 Rules 生成成功率。首次 63 份报告及历史模型候选均保持不变。


## 两次模型复验：未通过

用户明确确认发送范围后，向 api.deepseek.com 发起两次 CASE-020 修复调用，到上限停止：第 1 次 4,698 tokens，第 2 次 5,117 tokens，共 **9,815 tokens**。本轮两份候选均编译通过、严重规则违规为 0，但都在真实排队取消检查失败。累计 v5 及独立修复调用为 **81 次、196,443 tokens**，不能将这些修复成本或结果混入首次三策略比较。

第 2 份候选源码 SHA-256 为 `796c564a1b66ff483453d39803ab8e069323b8292b46e6800f7d777ebdf640f3`。发现两个实际缺陷：

1. `execute(() -> { task.run(); ... })` 入队的是包装 Runnable，而 `removeCancelledTask(task)` 移除的是内部 FutureTask。内部句柄即使取消，队列容量仍被包装器占用。运行失败：`Cancelled queued export still consumes capacity`。
2. `shutdownNow()` 取出尚未启动的包装任务后仅记录数量，没有取消其执行句柄或完成对应 CompletableFuture。独立关闭检查失败：`Shutdown stranded queued export caller`。这不是源码推测，已经在未经修改的第 2 份候选上单独复现。

这说明当前静态规则通过不能替代任务验收。没有添加仅凭 `cancel` / `remove` 文本就判通过的检查器；补充 TP-SUBMIT-002 的知识说明，明确移除对象必须与实际入队对象一致，以及关闭必须让等待结果结束。参考实现仍直接提交 FutureTask 并追踪未完成句柄，已满足这两项要求。

验收保留默认完整路径，增加 `queued-shutdown` 独立场景，避免前面的失败遮住后面的关闭缺陷。回归新增第九个可编译反例：保留 cancel 和 remove，但引入包装器使对象不匹配；也验证独立关闭场景能接受参考实现、拒绝遗弃结果的反例。定向 Java 回归通过，日志 `/tmp/export-wrapper-regression.log`。

原始两次请求、响应、候选及检查保存在 `.eval-cache/deepseek-v5-export-followup/CASE-020/`。零模型调用的独立复验与绑定源码哈希的失败审查在 `independent-verification/`，任务结论为 **failed**。原始 result.json 的缺少审查状态仍保留，未用后续审查覆盖历史记录。首次 v5 报告保持原 SHA-256 `a64ca646481159ac4e39d40d293af1fb0eae6b853573ce3792b931ca32e01f58`。

下一步先把这两个缺陷作为修复反馈，再进行新的受控模型复验；本轮两次额度已用完，没有第三次调用。其余 P1 业务验收缺口继续以 ACCEPTANCE-MATRIX.md 为准，Phase 1 尚未完成。

本次收尾验证：导出正例、九个可编译反例及独立关闭场景均符合预期；规则流水线、检索和校验回归 **60/60 通过、0 跳过**（`/tmp/export-knowledge-regression-verified.log`）。TypeScript 类型检查和 git diff --check 通过。新验收器哈希记录于独立复验 checks.json，历史验收器的审计证据保持原样。


## 2026-10-26：延续修复与源码审查

用户授权后续模型调用直接执行。本次额外调用 **3 次，共 17,747 usage.total_tokens**；v5 首次实验及其后续累计 **84 次、214,190 tokens**，未换算金额。每个修复批次仍有显式上限，相同候选会停止，避免无效循环。

| 独立轮次 | 调用 / tokens | 结果 |
| --- | --- | --- |
| deepseek-v5-export-continuation | 2 / 11,189 | 首次修复入队对象身份；第二次返回相同代码，stalled。关闭仍挂起。 |
| deepseek-v5-export-shutdown-followup | 1 / 6,558 | 通过编译、公开 API、完整运行验收和两个独立关闭场景；新候选尚无匹配审查，原始状态保留为 unverified。 |
| deepseek-v5-export-reviewed-verification | 0 / 0 | 同一模型源码完成哈希绑定的源码审查后再次运行验收，最终 **passed**；24 条适用检查，0 违规。 |

最终模型候选 SHA-256 为 `10e734cabd2040ba339971cfc29b19e92e924b079390a3eda178bd51fe3f28d7`。没有手改模型源码，也没有替换手写 good.java。模型改为直接 `execute(task)`，通过 FutureTask.done 将真实结果、异常和取消传播到 CompletableFuture；提交前登记 inFlight，停止准入和提交使用同一 admissionLock。强制关闭及中断关闭取消尚未完成的句柄，完成后清理登记。等待终止失败向 stop 调用方抛异常，不仅记录日志。

这次同时修复实验流程的不足：

- 增加 `--continue-from PREVIOUS_REPAIR`，从经过记录、验证的最终候选继续，而非每轮回到首次代码。校验父轮、result、候选及验证源码哈希，记录延续链，拒绝变更后的源码。
- 增加可选 reviewsDir，允许使用绑定当前源码的审查作为修复反馈，并保存审查文件哈希。新候选必须重新审查，旧审查不会批准修改后的代码。
- 每个 CASE-020 候选独立运行 queued-shutdown 和 uninterruptible-shutdown，即使完整路径已在更早的断言失败，也能反馈关闭缺陷。保留原始日志，断言明确说明结果未被完成的责任。
- 新增不响应中断的实际回调，验证 stop 在有限时间内报告未终止；第十个可编译反例把异常改成日志，必须被拒绝。

源码审查与参考实现依然独立。通过仅涵盖当前注入回调契约；不证明真实 HTTP/SQL 下游一定可取消、不提供持久化补偿，也没有穷举所有竞态。人工分析反馈是本次定向修复的额外投入，不能据此声称原始 Rules 自动生成通过或普遍优于 RAG。

最终完整回归 **128/128 通过、0 跳过**（`/tmp/export-closure-final-tests.log`），包括导出正例及十个可编译反例、延续候选防篡改、不同父轮拒绝、审查反馈与重复候选停止。TypeScript 类型检查及 git diff --check 通过。最终复验状态 passed，汇总为 `.eval-cache/export-closure-summary.json`；首次比较报告哈希保持不变。
