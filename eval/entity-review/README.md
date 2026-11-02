# 知识叶子—实体标签—修改任务：领域评审流程

本阶段不调用模型。交付的三项任务是 **Agent 自编开发候选**，不是独立真实项目或盲测集；现有 Apache 兼容性样本已经参与过分析，也不升级为新保留集。当前评审为空，指标未核定。真实项目来源和领域评审者仍待提供。

## 本轮候选与对应关系

| 候选任务 | 修改实体 / 可见证据 | 要验证的问题 | 独立知识标签 |
| --- | --- | --- | --- |
| REVIEW-CAPACITY | ExportWorker.export → pool；另有不相干审计上下文 | 用下游并发、内存预算及最小缓冲约束决定配置，不直接给唯一构造参数 | 待领域评审，不自动填 |
| REVIEW-TENANT | TenantBatchService.process → submitWork → workers / TENANT；同时保留 TenantProcessor 和独立审计调度 | 现有标签及有限 helper 关联能否覆盖真实修改范围、不召回无关资源 | 待领域评审，不自动填 |
| REVIEW-FAILURE | ExceptionWorker.deliver → worker，已有实际异常路径 | 从已有执行代码召回异常记录知识，而非人工 planned 新能力 | 待领域评审，不自动填 |

所有任务 planned=[]，准备器拒绝在主队列混入 planned。接口和实现方法签名相同时必须带 owner 选择，例如 `TenantBatchService::process(String,String)`；不把接口声明本身假装成已有实现标签。

15 个叶子的语义问题、适用 / 排除情形和所需事实整理在 leaf-guide.json。它是 Agent 草案，需要领域确认；只补充评审定义，未更改原知识树、checker 或历史分数。叶子是一个可独立回答的局部问题，决策叶子需要事实和取舍，规范叶子表达义务；评审者可以指出现有粒度仍需拆分，不默认本树已最优。

## 评审包与引擎预测分开

```text
prepare
├── reviewer/                       单独发给领域评审者
│   ├── tasks.json + inputs/        任务、事实、源码和结构实体 ID
│   ├── leaf-catalog.json           全部叶子、语义草案；无匹配特征条件
│   ├── sources/                    原知识文档
│   └── annotations.template.json   全部空白，不是引擎生成的标准答案
├── engine/                         开发者查看，不混入评审分发
│   ├── graphs/ + predictions.json  实际图、标签、预算及省略
│   └── correspondence.md           对应表，明确标为预测而非答案
└── review-state.json               awaiting_external_review，metrics=null
```

归档 `prepared/2026-11-02/reviewer-package.zip` 仅含 reviewer/ 内容，不含 engine/、参考实现和行为测试。应单独分发这个包，而不是让评审者先看整个开发仓库 / 引擎结果。分离是减少先入为主的工作流措施，不是访问控制或真正身份认证。

评审者复制模板到包外，为每个任务的每个叶子填写：

- required：完成本次任务不可缺少；helpful：相关但非必要；irrelevant：与本次修改无关；uncertain：资料或定义不足，不能按无关处理。
- 给出理由；required / helpful 要指向本任务公开实体列表中的源码证据。接口、类、字段和方法均可作为证据，不得跨任务乱用实体 ID。
- 填写真实身份以及独立于引擎开发、不是任务作者、未先看引擎预测、已审阅叶子定义的声明。已看预测者可以提出普通开发反馈，但不能虚称该独立基线；程序不会替人声明。

独立性是评审者自声明、未做身份认证，报告会一直保留这个限制。即使标注完成，也不会自动把自编候选改叫真实独立保留集。

## 冻结、密封与评分

```bash
# 生成新包；拒绝覆盖已有目录
node eval/entity-review/workflow.ts prepare eval/entity-review/suite.json .eval-cache/review-new

# 待真实领域评审完成后：filled.json 是在包外填写的模板
node eval/entity-review/workflow.ts seal \
  .eval-cache/review-new/reviewer filled.json .eval-cache/sealed-review-new.json

# 密封前不打分；不能拿空模板或引擎预测代替 filled.json
node eval/entity-review/workflow.ts score \
  .eval-cache/review-new/reviewer .eval-cache/sealed-review-new.json .eval-cache/retrieval-metrics-new.json
```

包绑定源码、任务、语义目录、原知识来源、知识树和预算的指纹。源码 / 任务 / 知识 / 预算变化、叶子漏填、未知叶子、实体错绑、声明不全或密封后改动会拒绝评分。若业务任务或叶子定义需要修改，创建新包并重新确认，不悄悄沿用旧标签。

指标分别报告：

1. **不裁剪的候选集合**与 required 标签的覆盖，反映打标及引用展开是否漏掉知识。
2. **预算内选择**的 required 召回、相关精度、无关数量、不确定数量和预算省略的 required 叶子。
3. required + helpful 算相关；uncertain 不进入精度分母；没有可判定选择或没有 required 时，相关指标为 null，不设成 100%。
4. 实体证据与引擎来源实体并列展示用于复查。这不是对所有类 / 接口标签或所有图边的穷尽标注，因此 full_entity_tag_accuracy 仍为 null。

该评分只衡量任务相关知识召回，不衡量模型代码质量，更不等于生产正确性。未收到真实标注前，准备产物 metrics=null；单元测试的模拟评审身份和标签只在临时目录中存在，不作为领域评审结果归档。

## 行为验收草案与评估口径

AcceptanceTest.java 与 references/ 只用于核验候选任务和验收器：不属于任何模型策略，不是独立答案或供应商输出。

- 容量任务按题设估计内存检查队列范围 4～16、并发不超过下游上限，检查真实回调、拒绝和正常排空；两种不同配置参考均通过。不声称实测了生产堆占用、吞吐或延迟。
- 租户任务观察调用方与固定复用工作线程，覆盖成功 / 异常、原值 / 原无值、原始错误原因、接口与审计调度保持；worker-only 清理变体应失败。
- 异常任务观察真实回调失败记录及原因、后续消息、业务线程前缀、容量和拒绝传播。不会再仅因“后续任务仍执行”就判断失败记录正确。

验收草案使用可反射观察的现有 ThreadPoolExecutor，包装器或不同架构需要评审适配，不把观测不兼容一概当作真实业务错误。本目录还没有接通新候选的付费执行，也不能直接拿它代替旧 tagged-edit 的固定验收器；应在领域审查后再冻结下一轮模型实验。

edit-audit.ts 保留输入 / 输出原始诊断，分别列消失、新出现、共有的规则类别；**类别或数量相同不证明同一缺陷保留，新增类别不等于新增真实缺陷**。拒绝传播和局部 catch/记录/再抛可以同时满足，不能把它们简单当成绝对冲突，也不能自动抹去组织规范。相关命中只标记 requires_policy_review，完整任务完成率和新增缺陷数不凭规则差值推断。

## 下一步的实际缺口

需要真实 Java 项目 / 修改需求及未参与引擎和任务开发的领域评审者。先核对叶子定义与源码标注，再冻结新的独立任务、行为与政策；最后才考虑新一轮受控三组模型调用。原 9 次真实试点、参考演练、原模型源码与报告均保持不变。

本轮验证：类型检查、JDK 21 与固定依赖校验通过，完整回归 183/183、0 失败、0 跳过；本轮真实模型请求 0。实际领域标注仍为空，不能引用测试模拟标签作为独立成绩。
