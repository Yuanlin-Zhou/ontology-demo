# CASE-006 业务验收与修复

## 修复范围

旧的 CASE-006 验收仅排除 PriorityBlockingQueue + DiscardOldestPolicy，FIFO 队列也能通过；原 good.java 同样删除了优先级。这会把规范合规误报为业务完成。

本轮冻结 PoC 的显式接口：保留 dispatch(String)，默认优先级 0；新增 dispatch(String,int)，数值越大越优先，同级 FIFO。新增 Consumer<String> 构造注入真实处理回调。队列满时，在优先级不高于新任务的任务中，淘汰最低优先级中最旧的一项；若全部更重要则拒绝新任务。这是对原始简略需求的具体化，不是从原始 taskId 推断业务优先级。

参考实现已重写为真正有界的优先级队列，容量检查、入队、出队及替换共享一把锁；core=max 防止新增工作线程绕过队列。关闭与公开提交同步，异常、淘汰和拒绝可观察。默认回调只记录处理，真实下游由宿主注入，不代表已有生产业务集成。

## 验收与门控

`eval/acceptance/CASE-006.java` 用实际线程执行以下检查：优先级顺序、同级 FIFO、旧接口默认优先级、最高优先级最旧任务保留、低优先级最旧淘汰、同级满载替换、全部更重要时拒绝、32 个并发提交的容量边界、异常后继续执行、关闭后拒绝。排序检查使用单工作线程固定时序；另外保留原始生产参数填满队列，验证低优先级任务不能借非核心线程扩容绕过拒绝。

回归同时验证正确参考实现，以及 FIFO、错误淘汰最高优先级、生产参数扩容绕过拒绝三个反例。新增噪声日志回归：诊断限长仍为 12000 字符，同时保留开头、末尾以及异常标题，避免日志或递归堆栈淹没真实错误。

核心 `Verification.task` 是可选的完整任务门控：failed/timeout 会触发修复，not_run/unavailable 保持 unverified。省略此字段保留原宿主“配置的检查通过”语义。真实实验适配器始终显式设置；CASE-006、CASE-019 使用覆盖当前清单的确定性断言，其他用例需要绑定当前源码哈希的完整审查。失败审查包含具体证据并优先于局部测试通过；修改后的候选不能继承旧审查。

修复目标增加 task_check=failed；显式 revised-engine 定向选择会用当前验收重检，即使父轮局部检查曾通过。评测报告遇到编译或功能失败直接标记任务失败，不再被缺失审查掩盖成 not_run。

## 独立模型轮次

所有轮次使用 deepseek-flash，每轮最多 2 次，仍从 v5 首次生成的 CASE-006 开始。没有把手写参考实现作为模型产出，没有覆盖历史源码或报告。

| 独立目录（.eval-cache/ 下） | 实际调用 | tokens | 结果 |
| --- | ---: | ---: | --- |
| deepseek-v5-priority-followup | 2 | 9869 | 第一次泛型编译失败；第二次编译通过但仍 FIFO，任务失败 |
| deepseek-v5-priority-rules-followup | 2 | 16735 | 已实现排序，但替换入队后递归 execute，反复淘汰；失败日志暴露诊断截断问题 |
| deepseek-v5-priority-feedback-followup | 1 | 5415 | 当时的单工作线程验收通过；后补生产参数验收发现扩容绕过拒绝，不能作为最终通过 |
| deepseek-v5-priority-production-followup | 1 | 5791 | 编译、API、增强后的排序/过载/生产参数验收及 error 规则全部通过 |

第三轮的补测独立保留在 `priority-production-model-recheck.json`，原 result.json 不改写；参考补测在 `priority-production-reference-recheck.json`。递归淘汰故障的新诊断保留在 `priority-diagnostic-recheck.json`。

本次共 6 次额外调用、37810 tokens。连同前期 v5 共 77 次调用、175555 tokens。轮次间修改了规则、契约和验收，只能说明这个明确业务契约下的修复结果，不能证明 Rules 普遍优于 RAG，也不能换算为三组公平比较成功率。

首次 63 份报告 SHA-256 保持 `a64ca646481159ac4e39d40d293af1fb0eae6b853573ce3792b931ca32e01f58`。

模型候选通过的是上述限定契约。自定义 BlockingQueue 的所有接口、提交与关闭竞态、默认空回调及真实下游业务仍需额外审查，不能把该候选直接当生产组件。参考实现与模型原始产出分别保留。Phase 1 仍需完成其他用例的完整业务及异常路径验收，优先 CASE-017 的限流、导出的异常/取消及真实下游调用证据。

## 最终回归

真实 Java 21 和固定依赖下，全量 **123/123 通过、0 跳过**，日志 `/tmp/priority-verified-tests.log`；类型检查、`git diff --check` 通过。中间一次全量为 122/123：新增生产参数检查更早拦截了错误淘汰反例，而回归预期的是后面的排序异常。调整为先验证排序/淘汰、再验证生产参数，保留全部断言后全量重跑通过；旧日志 `/tmp/priority-final-tests.log` 保留。
