# CASE-017：真实下游限流验收

旧验收仅向执行器提交 isVirtual 探针，未验证 notify 的真实回调路径、下游并发或许可释放。原 good.java 还引用了未定义 logger。新参考实现保留 notify(String) 和无参构造，增加 LoomNotifier(int, Consumer<String>) 注入下游：在创建虚拟线程前非阻塞准入，饱和/关闭时同步拒绝；回调在虚拟线程中执行，正常、异常和启动失败路径归还许可。stop 停止准入并等待已接受任务结束，等待超时或中断明确报告。stats 提供 active/completed/failed/rejected。

独立 `eval/acceptance/CASE-017.java` 检查实际回调的虚拟线程身份、阻塞时 notify 及时返回、限额 2 下 24 个并发过载请求明确拒绝且准确计数、正常/异常/工作线程中断后仍可通知、失败计数与成功计数、拒绝任务不延后执行、调用方中断标记保留、关闭后拒绝，以及 stop 等待阻塞回调结束。测试使用注入的阻塞回调，不连接真实 HTTP 下游，也不能证明真实连接池的全局容量。

配套七个反例分别删除准入、泄漏许可、重复计数、改成平台线程、漏调下游、提前关闭及重复关闭提前返回；反例源码必须先通过 javac，再由运行断言拒绝。原有的 CASE-017 轻量探针已从共享验收器移除，防止两套入口混淆。

知识与反馈同步修正：平台线程快捷工厂的禁用约束不误套到 newVirtualThreadPerTaskExecutor；虚拟线程也需要有界业务准入。虚拟线程 ExecutorService 没有 ThreadPoolExecutor 的 getActiveCount/getQueue 等 API，监控建议改为业务计数，避免诱导生成不可编译调用。引擎仍只有 26 条规则，没有将 Semaphore 文本存在冒充正确限流证明。直接虚拟线程参考实现没有池模型，静态检查为 0 条；业务正确性由真实运行验收提供。

修复适配器将 CASE-017 纳入明确契约的任务门控，来源绑定及失败审查优先级保持不变。其他用例仍需要完整审查，不因此宣称 Phase 1 验收完成。

## 外部复验状态

此前自动审批拒绝发送 CASE-017 私有源码和验证反馈到 DeepSeek，理由是缺少对这份具体代码数据出境的明确授权。先完成本地可审阅准备，随后用户在明确的“发送 CASE-017 源码、规则与反馈到 api.deepseek.com，最多两次”询问后回复“继续”，本次按该确认执行。

本地预览仍保留在 `.eval-cache/virtual-followup-review/`，不改写此前 prepared_not_sent 的历史记录。实际提示词、原始响应、候选、usage、源码哈希及代码快照另行保存。

| 目录（.eval-cache/ 下） | 调用 | tokens | 结果 |
| --- | ---: | ---: | --- |
| deepseek-v5-virtual-followup | 1 | 4490 | 编译、API 和当时的运行验收通过；源码复查发现关闭未完成时第二次 stop 会直接返回 |
| deepseek-v5-virtual-stop-followup | 1 | 6583 | 从上一份候选继续；修复重复 stop，增强运行验收通过；旧静态检查误报等待 helper |

第二轮是 `engine.repair` 的单次有界继续修复，父源码、父结果、工作区 diff 与未追踪文件哈希均记录在 experiment.json。共 **2 次调用、11073 tokens**，未超出授权上限；连同前期 v5 共 79 次调用、186628 tokens。

第二份候选将等待提取为 private awaitTermination()，真实运行通过，但旧 checker 只认可当前方法中的等待，因此报告两处 TP-SHUTDOWN-002。修正引擎后新增单层私有、唯一、无参 helper 识别，仍按同一资源绑定；跨池、公共方法、重载歧义、调用在 shutdown 前、延迟 lambda 都不认可。该规则仍是有限文件内检查，不证明全部分支可达性。

原 result.json 的 failed 保留。随后对同一份源码及同一验收器哈希绑定的已有真实 Java 证据，零模型调用重跑静态门控，状态 passed，记录为 zero-call-engine-recheck.json；没有重生成、手改或覆盖模型候选，也没有回填首次比较结果。

历史 CASE-017 源码在新适配接口验收下编译通过，但缺少 (int, Consumer) 构造器，测试失败。这是新契约下的结果，不代表原始公平比较中的失败，也尚未验证其回调行为。首次 63 份报告与模型源码保持不变。

## 环境诊断

本次沙箱内 Node 启动 javac 出现 EPERM，而同一路径在 shell 和沙箱外版本检查正常；经自动审批后在沙箱外运行本地 Java 测试。验证器将 ENOENT/EACCES/EPERM 归为 unavailable，避免把执行环境限制误算成模型编译失败。没有修改网络策略或绕过代理。

## 下一缺口：导出取消

额外的零模型调用 Java 21 探针表明：对正在阻塞的任务，CompletableFuture.runAsync(...).cancel(true) 不发送工作线程中断；ExecutorService.submit(...).cancel(true) 则触发中断。证据 `.eval-cache/export-cancellation-probe.json` 及 `.eval-cache/ExportCancellationProbe.java`。它证明取消标记不能当作底层工作终止的证据，不证明任意下游都响应中断。CASE-020 的超时/取消验收与实现仍待完善，本轮没有把该缺口宣称为已修复。

## 最终验证

配置真实 Java 21 与固定依赖后，全量 **125/125 通过、0 跳过**，日志 `/tmp/virtual-verified-tests.log`；类型检查和 `git diff --check` 通过。首轮全量为 124/125，唯一失败来自规则文案变长后，旧预算测试仍要求某个已满足规则必须被排除；现直接断言选中的违规规则在已满足规则之前，允许剩余空间填充，保留 400 token 上限。旧日志 `/tmp/virtual-full-tests.log` 保留。

验收开发中还修正了局部变量重名，以及关闭反例使用 while(false) 导致 javac 拒绝的问题；最终六个反例均通过编译后再由运行断言拦截。首次报告 SHA-256 仍为 `a64ca646481159ac4e39d40d293af1fb0eae6b853573ce3792b931ca32e01f58`。

模型产出通过的是注入 Consumer 的限定契约；默认 defaultRemoteNotify 仍为空，未连接真实 HTTP 下游，不能直接当生产通知服务。强制关闭时全部竞态、全局连接池容量与长时间不响应中断的下游仍需额外验收。Phase 1 尚未完整验收。

## 用户确认后的收尾

新增重复关闭和私有 helper 回归后，最新完整检查为 **126/126 通过、0 跳过**，日志 `/tmp/virtual-helper-verified-tests.log`。此前在模型验证与定向回归并行时，一次 javac 超时，日志 `/tmp/virtual-repeated-stop-tests.log` 保留；这次串行执行测试文件，保留原 10 秒检查超时和全部断言。

对最终模型候选还重新执行了真实 javac、增强后的 CASE-017 运行验收、公开 API 结构及当前引擎检查，全部必要门控通过，额外模型调用为 0，结果保存在 `.eval-cache/deepseek-v5-virtual-stop-followup/fresh-verification.json`。未修改任何模型源码。仍保留 TP-MONITOR-001 warning：静态模型未将独立业务计数与虚拟线程池关联，但 stats 计数已有运行验收证据；没有通过修改规则严重级别来消除此警告。
