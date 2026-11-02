# 按实体标签召回的代码修改实验 v1

目标：对同一份已有代码执行同一项修改，比较无知识、普通 BM25 RAG、按实体标签召回分层知识的规范遵循、修改成功率和知识 / token 成本。已有 flat Rules 实验作为前期探索，不能算作本方案效果验证。

## 已准备的开发试点

| 任务 | 可编译初始代码 | 修改目标 | 标签与新增能力 |
| --- | --- | --- | --- |
| EDIT-QUEUE | BufferedNotifier | 限定为 2 项排队，显式拒绝，保留业务回调和正常排空 | send 方法标签 + 引用线程池字段的参数决策标签 |
| EDIT-ASYNC | EventPublisher | 同步发布改为实例线程池异步发布，固定单 worker、有界缓冲、异常隔离和关闭等待 | 当前代码无池标签，显式 planned 叶子补足新增能力 |
| EDIT-CONTEXT | TenantJob | 恢复调用方和复用工作线程在成功 / 异常路径的原租户上下文 | run 及引用字段 / helper 标签 |

这些输入、任务、验收和 references 都是本次为开发试点编写的，不是独立保留集。cases/ 是完整的已有 Java 代码，先用 javac 确认能编译，不再让“补齐脚手架”混入修改效果。references/ 是 Agent 编写的验收器参考修改，不是模型供应商输出，不计入任何策略成功率或 token 指标。

## 三组控制条件

- 相同任务、负载 / 业务事实、修改目标实体、完整初始源码和公开交付约定。计划新增能力的理由也加入三组公共输入。
- baseline：不注入知识；rag：现有两份文档 BM25，topK=5；tagged：实体标签 + 两跳文件内依赖 + 显式计划，召回知识树叶子。
- RAG / tagged 的完整知识序列化估算预算均为 1200；实际取到多少单独记录，预算相同不代表实际 token 数相同。
- 建议初始模型 deepseek-flash、temperature=0、输出上限 8192，三组保持一致。当前只是准备参数，未请求供应商；DeepSeek 不支持固定 seed，不宣称确定性。未来运行需记录实际返回模型和应用参数，不能默默改别名。
- suite.json 的 repetitions 可在运行前冻结为多次；当前准备为 1 次 × 3 任务 × 3 策略，共 9 个槽位。不得看结果后只补跑不利或有利样本。
- 首次修改独立统计，默认无 Repair；任何后续修复单独计划、预算和归档。

这三组比较的是完整方案，包含知识整理方式和召回方式的共同影响。不能据此单独证明“标签选择算法”比文本相关性强。若要隔离该因素，后续需增加“同一叶子知识语料、不同召回方式”的消融，但本轮不扩大组数。

## 记录与指标

1. **召回链路：**实体 / 图版本、源哈希、叶子 ID、证据、显式计划、依赖展开路径、预算省略。另由独立标注确认应召回的叶子，计算知识覆盖与无关召回，不用引擎自己的标签作为标准答案。
2. **修改结果：**真实 javac 编译、AcceptanceTest 的实际回调 / 队列 / 拒绝 / 上下文 / 关闭验证，保留原始诊断及超时。编译失败和测试 unavailable 分开记录。
3. **规范遵循：**复用现有 engine.validate，保留 rule ID、severity、实例数；排除 info 的遵循率只是 checker 覆盖口径，误报需独立裁定，不能代替业务完成度。
4. **完整任务审查：**公开 API 和无关行为是否保持、是否实际处理回调、是否只做任务需要的改动。行为验收通过仍需审查，尤其异常日志、所有并发 / 关闭分支不能只靠有限测试宣称完整正确。
5. **成本：**知识估算 token、供应商实际 prompt / completion / total usage、时延、建树和打标维护投入。没有 provider usage 时记 unknown，不记 0；当前 0 表示没有请求，不表示已生成代码没有成本。

对总样本、多次重复报告全部结果和波动；开发试点不用于宣称统计显著性或普遍收益。后续正式验证需另设未参与知识树和 checker 调优的真实修改任务，事先冻结任务、预期叶子、行为用例和继续 / 停止标准。

## 可执行准备和本地评估

```bash
node eval/tagged-edit/prepare.ts eval/tagged-edit/suite.json .eval-cache/edit-run-new
```

产物包括 manifest、冻结的源码、图、验收器、suite 和 9 份提示词。manifest 明确 prepare_only=true、model_requests=0、quality_results=null；预备槽位不计作生成失败或成功。

当前没有启用付费模型执行器。未来受控执行前还需接通生成适配和可靠调用记录，保留实际参数、响应、usage、提取与源码哈希，先确定预算再执行；不能把手工 / 参考源码导入包装成受控模型结果。

如仅需本地核验导入代码，将源码放入 `results/<baseline|rag|tagged>/<CASE-ID>-<repetition>.java`，再执行：

```bash
EVAL_JAVAC="$PWD/.tools/jdk/bin/javac" EVAL_JAVA="$PWD/.tools/jdk/bin/java" \
  node eval/tagged-edit/evaluate.ts .eval-cache/edit-run-new .eval-cache/edit-import-report-new.json
```

评估器拒绝被改动的冻结输入 / 提示词 / 验收器和知识版本，输出必须是新文件。所有导入结果始终标为 controlled_model_comparison=false、usage=null；不冒充受控生成或完整任务审查。缺失输出为 not_run，不计算成模型失败。初始代码在 behavior gate 中预期失败，参考修改预期通过；单独破坏工作线程恢复的变体也应失败，以验证验收器确实观察工作线程而不只检查返回值。

本轮本地验证：类型检查通过，JDK 21 与固定依赖校验通过，定向 9/9、完整回归 167/167，均无失败、无跳过；日志见 `eval/tagged-edit/validation/`。这些是实现与验收器的本地验证，不是三组模型效果成绩。
