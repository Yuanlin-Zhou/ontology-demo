# DeepSeek v2 可观察业务实验（2026-11-02）

用户确认已充值并要求恢复 DeepSeek API 后，在 4856e92、干净 work 分支运行 `node eval/experiment.ts eval/observable.example.json .eval-cache/deepseek-v2-20261102`。使用就绪的 EVAL_API_KEY 绑定及已放行的 api.deepseek.com，没有使用 Ruoli 密钥。此前 HTTP 402 和 Ruoli 连接失败记录保持原样。

## 本轮结果

9 个相同任务 × Baseline / BM25 RAG / Rules，各生成一次，共 27 次调用，全部成功提取代码；无重试、无 Repair。模型请求与返回均为 deepseek-flash，temperature=0、thinking disabled、max_tokens=8192。DeepSeek 不支持 seed，不能保证确定性。v2 可观察业务契约覆盖其中 7 个任务，CASE-006 / CASE-020 继续使用其专门验收。

| 策略 | 平均规范遵循率 | error 诊断实例 | 全部诊断实例 | 编译 | 业务验收 | usage.total_tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 84.7% | 6 | 33 | 9/9 | 2/9 | 17,561 |
| BM25 RAG | 86.7% | 6 | 29 | 9/9 | 3/9 | 25,401 |
| Rules | 88.4% | 4 | 26 | 8/9 | 3/9 | 26,707 |

总计 69,669 tokens。遵循率为自动检查的逐文件均值，排除 info；全部诊断实例包含 info。诊断尚未逐条裁定真假，不能把表中数字当成已确认的真实违规数。token 为供应商 usage，不换算未经核实的货币价格。

Rules 业务通过数与 RAG 持平，编译少通过一例；其 tokens 比 Baseline 多约 52.1%。这轮不能证明 Rules 整体更优。v2 契约较旧实验更严格，不能把通过率下降解释为模型质量退步。

## 失败与待审查

`audit.json` 保存每例首个失败位置，完整编译/行为输出在 evidence/report.json。主要失败为：

- 12 份输出允许配置构造接收 null；Baseline CASE-002 则无参构造因复用拒绝 null 的构造器而直接失败。这些边界要求已明确写入三策略共有的 v2 提示词。
- Baseline、RAG CASE-006 的优先级队列实际无界；Rules CASE-006 自定义 BlockingQueue 缺少 Queue.peek 等必需实现，javac 拒绝编译。
- Baseline、RAG CASE-020 泄漏调用者线程上下文；Rules CASE-020 取消的排队导出仍占队列容量。

失败断言可能遮蔽后续问题，这不是完整缺陷清单。19 例被编译或行为门控判为任务失败；其余 8 例仅通过自动验收，尚待绑定源码哈希的任务审查（Baseline 2、RAG 3、Rules 3）。原始报告 Task Completion 的 0/9 不能解释为已测得的零成功率；当前完整任务完成率尚未核定。

## 证据与验证

`evidence/` 保留原始 manifest、27 个提示词、调用 usage、原始响应、提取源码、空审查模板和报告；未修改模型输出。report 中绝对路径指向运行时原目录，归档中的 results 等保留相同目录结构。audit.json 已核对调用数和源码 SHA-256，运行器确认 provenance 受控。

TypeScript 类型检查通过；JDK 21 与固定 Java 依赖校验通过；完整回归 147 通过、0 失败、0 跳过，日志见 validation.log.txt。本次没有修改引擎、知识或验收标准来消除失败。

下一步先对 8 个自动通过样本完成任务审查，再核查静态诊断误报/漏报；随后增加独立保留任务及 CASE-002 reload 超时/异常/中断路径测试。后续零调用分析单独保存，不覆盖本轮原始报告，也不直接追加付费修复。

## 零调用补充审查：强制关闭路径

本轮归档后，继续审查上述 8 份自动通过输出。全部在 stop 中忽略 shutdownNow 返回的未执行队列任务，违反本轮共有提示词中“强制关闭时处理未执行任务”的明确约定。新增独立 ForcedQueueProbe.java：固定一个工作线程，提交一个阻塞回调和两个排队回调，超过宽限触发强制关闭。8/8 均观察到 stop 正常返回、两个已接收回调未执行，计数 submitted=3 / completed=1 / failed=0 / rejected=0；源码同时确认没有处理或补偿返回任务列表。

此探针的 ok 表示成功复现丢失，不能解释为业务验收通过。forced-queue-probes.json 保存真实 JVM 证据，postrun-task-review.json 逐份绑定源码哈希和行号。没有新增模型调用，没有修改原始源码、报告或原有验收结果。

因此在原有 19 个自动门控失败之外，又确认 8 个契约失败。补充审查后的完整任务完成率为 Baseline 0/9、RAG 0/9、Rules 0/9，未核定项为 0；这是明确强制关闭约定下的结论，不代表所有基本业务功能都不可用。原始业务验收仍为 2/9、3/9、3/9，原始报告当时未审查的 0/9 不具有此补充结论的证据，须与本节分开阅读。

下一步优先将强制关闭丢任务场景加入后续冻结验收，并增加异常关闭、重复关闭等独立边界测试；再裁定静态诊断和准备保留集。新增验收用于以后实验，不追溯覆盖原始指标。
