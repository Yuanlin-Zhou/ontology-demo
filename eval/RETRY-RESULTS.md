# CASE-004：真实周期重试与异常隔离

## 本次结果

CASE-004 定向模型修复已通过：真实 Java 21 编译、公开 API、完整业务验收及五个独立场景均通过；20 条适用静态检查、0 违规。最终模型源码 SHA-256：`a9db73d2994ca67c2a448bb320f584f9ed471837a9b4a5433d8421a7b893b786`。模型源码没有手工修改，手写参考仍单独保留在 cases/CASE-004-scheduled-retry/good.java。

本次 **4 次模型调用、24,986 usage.total_tokens**（未换算金额）。v5 首次实验及后续累计 **88 次、239,176 tokens**。

| 独立轮次 | 调用 / tokens | 结果 |
| --- | --- | --- |
| deepseek-v5-retry-followup | 2 / 11,576 | failed：首份无参构造被非空校验拒绝；第二份又允许公开三参构造传 null。 |
| deepseek-v5-retry-continuation | 1 / 6,581 | stalled：保留相同候选；独立验收另指出关闭后错误使用 IllegalStateException。 |
| deepseek-v5-retry-contract-followup | 1 / 6,829 | passed：区分私有未配置初始化与公开构造非空校验；关闭后抛 RejectedExecutionException，并记录拒绝订单。 |

失败和停滞轮次保留原始候选、原始响应、提示词、usage、源码哈希及检查；没有重写首次比较报告。当前共享接口和强验收不同于旧实验，不能把这次成功回填成原始 Rules 一次生成通过。最终成功还包含澄清交付约定的额外投入，不代表单靠静态规则自动解决全部问题。

## 补齐的业务接口与行为

原参考实现的 retry(String) 是空方法，旧测试只证明 scheduler 周期运行，不证明订单真的被重试。现在注入 `Consumer<String>` 作为宿主提供的实际支付重试操作，支持明确的初始延迟与固定延迟（毫秒）。无参构造仍存在；未配置下游时 scheduleRetry 明确抛 IllegalStateException，不以空方法或日志冒充业务完成。公开三参构造对 null 回调及无效延迟明确失败。该契约同样提供给三个生成策略。

参考实现直接在定时工作线程调用注入回调，在任务体内 catch RuntimeException 并记录，失败后后续周期仍执行。关闭时停止准入并取消未开始的周期/延迟注册，等待正在执行的回调；宽限后强制中断并有界等待，调用者中断标志保留。关闭后拒绝请求以 pendingRetries 内存队列供补偿观察。

## 验收与反例

独立验收 eval/acceptance/CASE-004.java 覆盖：

- 首轮注入业务异常后再成功三轮，回调接收原始订单 ID，在工作线程执行；另一订单仍继续重试。
- 上一轮实际结束后等待固定延迟，不使用慢任务结束后追赶的固定频率，且同一注册不重叠。
- 初始延迟与参数校验；未配置下游显式失败。
- 关闭后不再调用回调、拒绝并记录订单、重复关闭不提前返回。
- 初始延迟很长但尚未开始的任务不拖住关闭；正在执行的可中断回调被停止；关闭调用方中断标志保留。

九个可编译反例分别删除真实回调、重抛首轮异常、换成固定频率、忽略初始延迟、吞掉未配置状态、只调度一次、丢弃补偿订单、关闭提前返回、吞掉关闭中断。每份反例先通过 javac，再被行为验收拒绝。

acceptanceScenarios 将失败恢复、固定延迟、延迟关闭、运行中关闭及中断关闭独立执行，避免最早的配置错误遮住其他缺陷。每份修复候选记录验收器哈希。两条原始任务清单均由真实回调验收覆盖，可自动给出 scoped task 结论；其他用例的源码审查门槛保持原样。

## 静态规则优化

TP-SUBMIT-005 原本只检查 execute 内直接显式抛出的异常，漏了周期任务停止这一风险。现对 scheduleWithFixedDelay / scheduleAtFixedRate 检查回调内部整体异常保护；提交外层 catch 和 ThreadFactory 的异常处理器都不能让失败的周期注册继续。

分析支持内联/不可变别名 lambda，以及一个无歧义的私有 helper。它不接受窄类型 catch、显式重抛或把另一个嵌套 lambda 的 catch 借给当前任务；helper 参数求值在 try 之前，包含调用等复杂求值时不能误判被 helper 保护。未知 Runnable/方法引用等实现保留 warning，需要另作源码/运行核查。该结构检查不宣称完整类型、异常及跨文件控制流证明。

## 证据边界

这里验证的是宿主注入回调的定时调度语义，不是支付网关集成。尚未实现退避策略、重试次数/停止条件、幂等与订单去重、注册容量上限及持久化恢复。ScheduledThreadPoolExecutor 的 DelayedWorkQueue 仍无界；removeOnCancelPolicy 不会把它变成有界队列。补偿订单仅在内存保存，不是可靠支付补偿系统。不可中断下游和全部并发竞态也未完整验证。

参考实现与最后模型候选均通过当前作用域，Phase 1 其余 P1 业务验收仍待补齐。原参考矩阵缓存及首次模型报告保持历史状态。


## 验证记录

- 完整回归 130 项中 129 项通过，新增重试反例验证遇到 javac 进程超时，原日志保留在 `/tmp/retry-final-tests.log`。随后单独复验也记录过一次运行超时，未放宽 10 秒上限、未将 timeout 当作有效反例。
- 对可疑单次调度反例单独定位：约 5.4 秒内完成编译及运行，按预期触发实际业务断言并正常退出；证据 `.eval-cache/retry-timeout-diagnosis/one-shot.checks.json`。
- 相同源码、相同上限下，新增回归最终单独复验通过，覆盖参考实现及九个可编译反例，日志 `/tmp/retry-final-verified-tests.log`。因此此次 130 项已有通过证据，但不声称一次全量运行 130/130 全绿。
- 最后边界修正后的规则流水线、数据集及知识回归 **57/57 通过、0 跳过**，日志 `/tmp/retry-engine-final-tests.log`；TypeScript 类型检查与 git diff --check 通过。

最后模型候选的源码哈希绑定审查为 `.eval-cache/retry-accepted-review/CASE-004.json`；模型完整/独立场景原始证据在 `.eval-cache/deepseek-v5-retry-contract-followup/CASE-004/`，成本及状态汇总在 `.eval-cache/retry-closure-summary.json`。参考实现的独立检查另存 `.eval-cache/retry-local-verification/reference.json`。首次 v5 报告 SHA-256 仍为 `a64ca646481159ac4e39d40d293af1fb0eae6b853573ce3792b931ca32e01f58`。
