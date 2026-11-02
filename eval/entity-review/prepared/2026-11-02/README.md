# 下一轮候选评审：等待真实领域输入

本目录不包含模型请求或完成的独立标签。review-state.json 的 metrics=null，independent_holdout_verified=false。三项输入为 Agent 自编开发候选，不能称为真实项目盲测集。

- **给评审者：reviewer-package.zip 或 reviewer/。** 只有任务、可编译完整源码、结构实体、叶子目录及原文档、45 项空白标签。不要先给他看 engine/ 或参考代码。
- **给开发者：engine/。** 图、实际预测、对应表和参考代码问题类别复盘，明确不是标准答案。
- **真实评审尚未完成。** 模拟身份及模拟标签只在临时单元测试中使用，没有填入本包或生成正式分数。

复制 annotations.template.json 到包外填写；使用 workflow.ts seal / score，新路径生成结果，不覆盖冻结包。source、task、knowledge、budget 和标注完整性均校验；不确定不按无关处理，空分母不记满分。评审者独立性仅自声明，不构成身份认证。流程、示例和验收边界见 `eval/entity-review/README.md`。
