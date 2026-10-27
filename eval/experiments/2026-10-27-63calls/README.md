# 合并后首次生成对比（63 次调用）

用户确认将 21 个 Java 评测用例、任务及规范提示词发送至 api.deepseek.com 后执行。冻结版本：830ccc90aa1aed1e1933fe2f7fc2245e34b45023，工作区 patch 为空，无未跟踪源文件。deepseek-flash，temperature=0，thinking disabled，输出上限 8192，知识预算 1200，RAG topK=5。DeepSeek 不支持固定 seed；实际参数 seed=null。21 例逐例交错执行三策略，共 63 次，无自动重试、无 Repair、无人工修改生成源码。

## 首次结果

| 策略 | 编译通过 | 行为测试通过 | 静态 error 诊断 | 全部 finding | 合规率（有效样本） | 实际总 token |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 21/21 | 18/21 | 29 | 62 | 82.2% (20/21) | 27,556 |
| rag | 20/21 | 18/21 | 24 | 50 | 85.6% (20/21) | 44,615 |
| rules | 21/21 | 19/21 | 8 | 41 | 90.9% (20/21) | 46,264 |

63/63 次调用保存了 provider usage，输入、提示词、原始输出、提取源码与调用记录的哈希通过核对；公开 API 结构检查 63/63 通过。纯金额 CASE-019 无适用线程池规则，合规率为 n/a，不能当作 100%。合规率不含 info，与早期四任务基准的含 info 口径不同，不能直接比较其数值。

本轮 Rules 的行为测试比 baseline 多通过一例，静态 error 诊断更少；总 token 比 baseline 高约 67.9%，比 RAG 高约 3.7%。只有单轮 21 个场景，尚不能证明普遍收益；token 是实际使用量，不是按价格换算后的费用，缓存折扣未折算。

## 失败与诊断

- CASE-006：三组均未通过。baseline / RAG 的 PriorityBlockingQueue(200) 实际无界；Rules 的队列淘汰遍历在更高优先级元素上提前 break，导致合法替换被拒绝；同优先级还存在选中新任务而非最旧任务的问题。
- CASE-017：baseline / RAG 的重复 stop 直接返回，未等待已接受的下游任务结束。Rules 通过本轮虚拟线程功能测试。
- CASE-020：RAG 构造器的 this::generate 导致 javac 失败。baseline / Rules 的调用线程 ThreadLocal 未恢复，均未通过原始断言。Rules 尝试 remove(inner FutureTask)，但队列实际保存外层 lambda，不能移除实际排队对象。

独立本地场景检查未追加模型调用，也未改变首次排名：baseline / Rules 都无法及时结束被 shutdownNow 排出的排队调用方；不可中断任务仍在运行时，stop 只写日志便正常返回。RAG 保留原始编译失败，不修改源码后重测。第一次诊断因本地 sandbox 返回 EPERM 为 unavailable，记录保留在 independent-scenarios-sandbox-unavailable.json；配置正确的本地执行记录在 independent-scenarios.json。

## 静态检查器误报与任务审查边界

Rules 的 8 条 error 是原始诊断数，不是 8 个已确认真实违规。其中 CASE-017 的 TP-SHUTDOWN-003 被源码审查及独立真实 Java 中断探针判为误报：loop/catch 设置标记，finally 恢复当前线程中断。其 TP-SHUTDOWN-002 涉及自定义 latch 等待任务与等待 executor 终止的策略差异，保留为需进一步解释。其他 6 条 error 有直接源码依据。未在本轮修改检查器来改变冻结结果。

Agent 对 9 个明确的冻结用例清单做了源码审查（004/005/006/012/013/017/019/020/021），共 27/63 份源码；并非人工审查，也不是完整真实业务验收。审查和自动检查共同确认任务通过的下界为 baseline 6/21、RAG 6/21、Rules 7/21，剩余各 12 个未审查用例保留 not_run，不能把这个下界当作完整任务完成率。CASE-005 只结合配置和 JDK 语义确认扩缩容条件，测试没有实际等待 60 秒回收。

部分 before/产出仍保留空的 sendRemote、syncRemote、doExport 等业务占位，线程池测试通过不能证明真实外部系统产生了业务效果。此处不通过修改验收口径或把未审查案例算成功来补足覆盖率。

## 记录与复核

完整证据位于 evidence/：原始 report.json / report.md、27 份 reviews/、独立 reviewed-report.json / reviewed-report.md、63 份 results/、prompts/、calls/、raw-responses/、实验 manifest、结构 API 审查、独立场景诊断及源码审查。first-pass-report.json 与 report.json 内容一致，后续审查复用冻结的编译/行为结果，未重新执行或覆盖首次结果。audit-scripts/ 保存了仅进行本地审查的辅助脚本；若复核，把它们复制回仓库 work/ 并去掉 .txt 后缀后，在仓库根目录运行，脚本不发起模型请求。

## 下一步

1. 补充可观察的业务契约与剩余任务审查，优先解决空占位方法导致的验收盲区。
2. 单独修复并回归循环 finally 中断恢复的静态误报；对自定义关闭等待作语义界定。新检查器版本只做明确标注的复验，不覆盖本轮。
3. 针对优先级队列、实际排队对象取消、shutdownNow 后完成等待方等问题完善约束和独立测试，再以新冻结版本比较收益与成本。
4. 当前不把 Rules 自动生成/修复设为默认；有进一步证据后再决定 Cline 集成范围。未经单独计划不追加付费 Repair 调用。
