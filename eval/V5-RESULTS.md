# v5 真实生成与修复验证

本轮使用核心流程审查后的引擎、deepseek-flash、temperature 0、thinking disabled；DeepSeek 不提供固定 seed。初次生成与修复分开记录，源码不自动修补，历史 v3/v4 结果不覆盖。

## 首次生成：21 用例 × 3 策略

63 次调用全部取得完整输出，无服务失败和截断。配置、源码、原始响应、提示词及哈希校验通过。完整原始报告在 `.eval-cache/deepseek-v5-full/report.json`，SHA-256 为 `a64ca646481159ac4e39d40d293af1fb0eae6b853573ce3792b931ca32e01f58`。

| 策略 | 编译通过 | 当前功能断言通过 | error 实例 | 全部违规实例 | usage.total_tokens |
| --- | --- | --- | --- | --- | --- |
| Baseline | 21/21 | 21/21 | 29 | 57 | 23611 |
| RAG | 21/21 | 20/21 | 25 | 55 | 40355 |
| Rules | 20/21 | 20/21 | 7 | 45 | 43591 |

首次生成合计 107557 tokens。接口结构审计发现 RAG CASE-016 将原 orderNotifier() 改为 orderNotifier(MeterRegistry)，其余 62 份的已检查公开结构保持不变；接口结构检查不能发现 import 缺失或证明业务正确。

Rules 唯一编译失败是 CASE-016 漏掉 ThreadPoolTaskExecutor import。历史 v3 的 CASE-005/007/011 错误 UncaughtExceptionHandler API 没有重现；本轮 Rules 首次编译为 20/21，历史为 17/21。由于规则文字、提示词、交付约定、分析器和对照检索均发生变化，不能把差异归因于某一项修改或单轮随机生成。

RAG CASE-016 编译通过，但没有约定的 stats 入口，运行检查失败；它虽然提供 MeterRegistry Bean，仍改变了原公开方法签名。此轮没有为 RAG 额外修复，不能把修复后的 Rules 与未修复的 RAG 当作等成本对比。

Rules 初始 error 分布：CASE-005 未关闭；CASE-006 拒绝/关闭问题；CASE-012 新增无界队列快捷工厂且未关闭；CASE-020 调用线程上下文写入缺少保护。CASE-012 说明只按修改前的代码召回约束有局限，生成后重新分析能够发现新增资源的问题。

Rules 的输入 tokens 为 28426，RAG 为 30177；Rules 输出更长，总 usage 反而比 RAG 高约 8%。上下文更少不自动等于总调用成本更低，此处不作金额换算。

## 首轮独立修复：5 个 Rules 目标

保留首次产出，仅向模型反馈真实诊断、当前适用规则、原始接口/业务输入及共享交付约定。每例最多 2 次、全局最多 12 次；完整记录在 `.eval-cache/deepseek-v5-repair/`。

| 用例 | 额外调用 | 首轮修复结果 |
| --- | --- | --- |
| CASE-016 | 1 | 补齐 import；编译、现有功能、公开接口和 error 规则检查通过 |
| CASE-005 | 1 | 增加关闭路径；已配置检查通过 |
| CASE-006 | 2 | 拒绝与关闭诊断清除；已配置检查通过，业务优先级仍未实现 |
| CASE-012 | 1 | 新增池的创建/关闭等 error 清除；已配置检查通过 |
| CASE-020 | 2 | 第 2 次返回重复候选，按策略停机，保持 stalled |

首轮修复合计 7 次调用、26271 tokens。重复候选未算成功，未覆盖其错误记录，也未无限重试。

## 导出上下文：修正反馈后独立追加一次

CASE-020 的停滞定位出两个具体不足：写入发生在 private validateTenant helper 内，原反馈没有指出未受保护的调用位置；验收只检查工作线程，漏了调用线程。模型第一次只在 export 末尾加 finally，validateTenant 仍在 try 之前，不能保护 helper 的异常路径。

因此修正引擎：一层私有 helper 写入仅在全部已知调用处都处于对应 try/finally 保护区时认可；否则反馈 helper 名和未保护的调用行。新增反例验证“一个安全调用不能掩盖另一个不安全调用”。运行验收增加导出前后调用线程上下文比较，配套真实 Java 正反例。

随后新建 `.eval-cache/deepseek-v5-context-followup/`，明确记录新引擎/测试的代码快照，最多 1 次调用，仅复验 CASE-020。该次调用使用 3917 tokens，产出将 validateTenant 移入 try，分别保存并恢复调用线程及工作线程的上下文；编译、增强后的运行检查、公开接口及 error 规则检查均通过。旧 stalled 结果不覆盖；该轮测试更严格，不能回填首次 63 份报告。

三轮总计 71 次模型调用、137745 usage.total_tokens；其中额外修复 8 次、30188 tokens。首次结果与各修复轮次分别保存，不拼接成新的一轮三策略成功率。

## 未通过的任务验收与剩余工作

CASE-006 最新候选虽然通过配置的检查，仍用 FIFO ArrayBlockingQueue，缺少优先级来源、分类和比较逻辑。已按原清单作 Agent 源码审查并判任务验收失败：`.eval-cache/deepseek-v5-repair/CASE-006/task-review.json` 和 `task-verdict.json` 绑定了该源码 SHA-256。该审查不是人工验收，也没有改写修复程序的原始检查记录。

所有首次报告的完整任务审查仍为 not_run。下游业务实现存在大量沿用原始输入的空方法/占位，线索保留在 `source-stub-audit.json`；不能把线程池运行断言说成下游业务端到端通过。空方法审计仅提供审查线索，不自动把所有占位判为同一种业务错误。

下一项实施应冻结任务级业务契约并补齐相应断言：优先处理 CASE-006 的优先级与淘汰语义，再处理 CASE-017 下游限流、导出异常/取消路径，以及真实业务调用证据。进一步复验须独立记录，Phase 1 尚未完整验收。

后续已完成 CASE-006 的显式契约、真实排序/过载/生产参数断言，以及任务验收门控；最后一个独立模型候选通过增强后的检查。包含中间失败及补测推翻局部通过的完整记录见 [PRIORITY-RESULTS.md](PRIORITY-RESULTS.md)，不回填本报告首次指标。

## 收尾验证

首次全量回归 118/120 通过，两例失败来自 javac 超时，原日志保留在 `/tmp/v5-final-tests.log`。编译器此前没有运行阶段已有的 JVM 资源约束，现统一增加 `-J-Xmx128m -J-XX:ActiveProcessorCount=2`，不增加检查超时、不更改断言，也不重算模型实验。随后全量 **120/120 通过、0 跳过**，日志 `/tmp/v5-final-bounded-tests.log`；类型检查与 `git diff --check` 通过。
