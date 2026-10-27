# Phase 1 实验协议（v4）

当前状态：核心引擎与离线评测完成；已完成 deepseek-flash 的完整 21 用例三策略实验，并对失败项定向修正和复验。逐轮结果见 [EXPERIMENT-RESULTS.md](EXPERIMENT-RESULTS.md)。自动功能测试尚未覆盖全部任务要求，任务清单审查仍未完成，不能据此宣布 Phase 1 完整验收通过。

## 实验设计

- 同一模型、seed、temperature、输出上限、输入代码、任务与交付约定；仅知识注入策略不同。
- 完整实验为 21 用例 × baseline / rag / rules = 63 次生成；配置可用 `caseIds` 选择试跑子集；正式三组比较须运行全部三种策略，定向诊断可显式设置 `strategies` 子集并单独报告。每轮使用一个独立目录，逐用例交错运行三种策略，不提供历史会话或答案文件。
- 默认建议 seed 42、temperature 0、输出上限 8192、知识预算 1200、RAG topK 5。模型与调用预算须在运行前确定。seed 不保证远程服务完全确定。
- 一次生成，不自动修复 Java 代码。允许提取整个响应中唯一的 Java Markdown 代码块，仅移除外层围栏；不接受多代码块、未闭合代码块或围绕代码的解释文字。原始响应与提取元数据必须保留。供应商失败立即停止，保留已有结果和其余缺失项；不要将缺失项删掉再计算成功率。
- 输入的 before/good/bad 是静态分析片段，包含未提供的业务成员和外部类型。模型必须提交完整源码，省略成员不能被自动补桩。保留原类名、公开签名、关键行为；功能测试部分依赖服务持有可反射访问的 ExecutorService 字段，采用完全不同内部架构的产出需单独审查测试适用性。
- Spring/Jakarta 使用真实依赖的 classpath；订单领域输入采用显式的 PoC fixture `Order(String id, String tenantId)`，不替代实际业务服务实现。缺失依赖须保留编译诊断，不用空实现库掩盖问题。单文件产出约定暂不支持跨包新增多个源文件。
- 21 个任务的完整验收清单定义在 `eval/acceptance.ts`，不随 prompt 暴露给模型。CASE-006 的“最旧”和“优先级”、CASE-019 的“补充价格逻辑”原始业务要求较宽泛，清单采用保留原行为与明确可观测结果的最小解释；正式实验前应冻结业务验收解释。

## 指标口径

| 指标 | 定义与限制 |
| --- | --- |
| Rule Compliance | 1 − 非 info 的违规规则去重数 / 非 info 的已检查且有 checker 的规则去重数；同一规则多处违规只扣一次。无适用规则、空产出或语法错误为 n/a，不算 100%。只反映实际产出中可检测规则，删除任务仍须功能/人工验收拦截。 |
| Violation Count | 单独保留违规实例数与违规规则数。原始实例数包含 info；合规率不计 info。 |
| Compile Rate | 真实 `javac --release 21 -proc:none` 成功数 / 全部计划用例。每次使用独立临时目录，保留诊断并清理 class 文件。 |
| Test Pass Rate | 配置的可信功能测试 main 编译并执行成功的用例数 / 全部计划用例。它是用例通过率，不能称为断言数量通过率。 |
| Task Completion Rate | 按清单逐条审查、证据完整且绑定源码哈希、并通过编译及已有自动测试的用例数 / 全部计划用例。没有审查即 not_run，不自动推断。 |
| Coverage | 所有率同时报告 evaluated 数量；missing / invalid / unavailable / not_run / timeout 在逐例表和 JSON 中独立记录。全部计划分母上的 0% 不等于所有用例都执行失败。 |
| Retrieval P/R/F1 | 当前离线指标使用未裁剪规则集合；100% 不代表实际预算下规则完整保留。RAG 的 Ref Recall 与规则 Recall 不是同一指标。 |
| Context Token Cost | 目前为字符启发式估算，包含知识正文，不等于完整 prompt 或供应商计费 tokens。实验记录可另存供应商 usage，不能将估算标为真实费用。 |

21 个用例均有至少一组功能/运行行为断言：金额与折扣、报价结果、异步提交、租户清理、周期调度、队列容量、拒绝计数与补偿、线程命名与复用、关闭等待与中断、虚拟线程、双池关闭及真实 Spring 生命周期。它们不完整覆盖每个任务，例如 CASE-006 的具体优先级与淘汰顺序、CASE-017 的下游限流和 CASE-020 的全部异常上下文路径仍须进一步测试与审查。

测试接口约定在三种 prompt 中一致公开：保留服务自有 executor 字段及 TENANT，上报接口为 stats()（Spring 可用静态 stats(bean)），库存与审计补偿使用 retryQueue / fallbackQueue，Bean 名为 orderNotifier。该约定限定本轮实验的可比实现形态，不表示其他架构错误；不适用该接口的产出需人工审查，不得未经说明改动测试使其通过。CASE-002/015 会临时把池限制为单工作线程，以确定性复现上下文复用和待处理队列；此变更只在临时测试进程中存在。

## 使用

准备真实依赖及明确的订单输入 fixture：

```bash
python3 scripts/setup-eval-java.py --jdk /path/to/jdk21
```

安装器从 Maven Central 下载固定版本 Spring 6.2.11、Micrometer Core/Observation/Commons 1.14.11、HdrHistogram 2.2.2、LatencyUtils 2.0.3、Jakarta Annotation 2.1.1，逐个验证 `eval/java-dependencies.json` 中的 SHA-256；初始摘要由 HTTPS 官方仓库与官方 SHA-1 校验后固定。只生成输入数据 record，绝不为日志、Spring 容器或业务服务伪造通过实现。将 `java.classpath` 设置为 `["/workspace/ontology-demo/.eval-cache/java-deps/*"]`，三种策略必须相同。模型 prompt 的交付约定公布这些可用依赖。

先确保 Java 21 JDK 可用；`java` 存在不代表 `javac` 存在。可以通过命令参数显式指定工具，不要求全局安装。

```bash
cp eval/experiment.example.json .eval-cache/experiment-config.json
# 编辑模型、供应商命令、预算及 Java classpath；配置文件中不放凭据。
node eval/experiment.ts .eval-cache/experiment-config.json .eval-cache/experiment-prepared --prepare
node eval/experiment.ts .eval-cache/experiment-config.json .eval-cache/experiment-run
```

供应商命令由 `spawnSync(command, args)` 调用，不经 shell；stdin 为 JSON：

```json
{"model":"configured-model","seed":42,"temperature":0,"maxOutputTokens":8192,"prompt":"..."}
```

stdout 必须仅为 `{"model":"configured-model","code":"完整 Java 源文件","usage":{}}`；异常非零退出。返回模型标识必须与配置一致，版本别名要先解析并固定。wrapper 必须实际应用请求参数，实验器不能独立证明远端执行了 seed 等设置。可选 `eval/providers/openai-compatible.ts` 接收此协议，通过环境变量 `EVAL_API_BASE`（HTTPS API 根地址、/v1 基址或完整 chat-completions URL）及 `EVAL_API_KEY` 调用兼容服务。按供应商支持情况调整参数；不自动重试或降级模型。不在日志或配置写入密钥。

模型调用参数示例：`command` 为 Node 的绝对路径，`args` 为 `["eval/providers/openai-compatible.ts"]`。域名须在环境网络设置允许，凭据仅在环境设置安全配置。运行时最大 63 次请求、每次最大 8192 输出 tokens；这不是金额上限，执行前需按指定模型价格核算预算。

DeepSeek 使用 `eval/deepseek.example.json`：模型为已通过 `/models` 确认可用的 `deepseek-flash`，接口变量可使用 `EVAL_API_BASE=https://api.deepseek.com` 或完整的 `/chat/completions` 地址，密钥通过安全环境绑定 `EVAL_API_KEY` 提供，允许目标为 `api.deepseek.com`。在当前 Node 24 云环境通过 `--use-env-proxy` 使用会话代理及其凭据注入；保留系统 CA 配置。DeepSeek 请求不发送其不支持的 seed 参数，调用记录中 `applied_parameters.seed` 为 null，因此不能声称固定 seed 保证可复现。DeepSeek 当前实验关闭 thinking，并在实际调用参数中记录该设置。

每轮保存实验配置、Git revision/工作区 diff、未追踪文件哈希、prompt 与源码哈希、调用状态/耗时/usage。`--prepare` 仅准备 63 份提示词与审查模板，不调用模型，不代表已有实验结果。示例模型与路径必须在真正运行前替换。

模型原始文本位于 `raw-responses/<strategy>/<caseId>.txt`；兼容供应商 wrapper 还会保存完整响应 JSON。提取后源码位于 `results/<strategy>/<caseId>.java`，调用记录包含原文 SHA-256、源码 SHA-256 和提取方式；重新评测时核对原文与提取源码的一致性。v1 历史失败记录保留，不覆盖；使用 v2 重新检查历史产出必须单独标记为复验，不能视为新的模型实验。根据 `review-templates` 逐项填写审查（明确记录是人工或 Agent 审查），将源码 SHA-256、审查者与逐项证据保存到 `reviews/<strategy>/<caseId>.json`；`passed` 必须为布尔值，不能沿用 null。代码改动后原审查失效。

```bash
npm run engine -- eval --agent-results --out .eval-cache/experiment-run \
  --javac /path/to/jdk/bin/javac --java /path/to/jdk/bin/java \
  --release 21 --timeout-ms 10000 --classpath /path/to/dependencies
```

不使用默认 `npm run eval` 的输出目录重写历史报告；始终传 `--out`。编译/测试失败详情在本轮 `report.json` 中。已有无模型产出的离线报告保留为离线证据。

## 进入下一阶段的条件

审查已明确的业务输入与测试约定，补齐未覆盖的业务/异常测试，运行真实三组生成与任务审查，比较合规率、功能、编译和任务完成情况。确认收益没有以功能退化或漏做任务为代价后，再决定是否进入 Cline 深度集成。单轮 21 例只能提供探索性证据，不能证明普遍优于所有 RAG 实现。

## 已有 CASE-012 产出的无调用复验

对先前 `deepseek-flash` / rules 的同一份输出按 v2 提取围栏后，补齐 Micrometer Core 与官方 POM 指定的两个运行依赖，Java 编译和报价功能断言通过。原始文本和源码哈希均保留，本次新增模型调用为 0，历史原始编译失败结果没有覆盖。

规则检查仍报告 `TP-SHUTDOWN-002`：关闭线程池没有等待任务终止。这是生成代码的实际违规，未通过修改代码消除；功能测试通过不能替代规则合规或完整任务验收。该复验只是单例，不能作为三种检索策略的对比结论。

## CASE-012 三策略试跑

配置增加 `"caseIds": ["CASE-012"], "maxCalls": 3`，可仅运行此用例的三个策略。未知用例、重复选择和不足以覆盖三策略的请求上限会被拒绝。重新评测时使用 `--case-ids CASE-012`，避免把未选择的 20 个用例算成缺失产出。

本轮使用 deepseek-flash、temperature 0、thinking disabled、同一输入与依赖，恰好生成 3 次，共 7074 个实际计费口径 tokens（usage.total_tokens；未核算金额）。Baseline 与 Rules 编译和基础报价测试通过，阻塞业务线程池下的异步返回/超时诊断也通过；RAG 使用未配置的 SLF4J 而编译失败，源码审查还发现方法在返回前同步等待 Future。Baseline 有两条关闭待处理任务的警告，Rules 有一条关闭不等待终止的错误。

本轮没有证明 Rules 更优。只有一个任务、每策略一次，适用规则分母还会随代码变化。通用交付约定中与当前任务无关的订单、租户、补偿队列要求诱导了额外实现；扩大实验前应改为逐用例的接口约定，并冻结后再运行。历史原始输出和指标必须保留。

## v3：试跑后的评测修正

- 交付约定由 `eval/delivery-contract.ts` 按用例生成。报价用例不再收到订单通知、租户或补偿队列等无关要求；三种策略仍共享同一用例的同一约定。
- 统一支持真实 SLF4J API/Simple 2.0.17，版本和 SHA-256 固定，日志不使用空实现。新一轮开始前完成依赖准备，不回写历史轮次来改变分数。
- CASE-012 的正式验收除正常报价外，还会占满业务工作线程，检查方法及时返回未完成 Future，随后出现应用自己的超时；同步等待再返回 Future 会失败。
- 测试适配器无法观察某些合法内部架构时记录 `unavailable`，不将无法验证误当作功能错误或通过。其他用例仍只覆盖部分业务行为，完整任务完成度需要逐项审查。
- `--resume` 只用于同一配置、代码和提示词的中断轮次。保留已记录的调用（包括失败或状态不明的调用），不自动重新计费重试；每个槽位最多调用一次，运行锁阻止并发重复调用。失败槽位可保留为失败结果，必要时另建明确标记的重试轮次。
- 多代码块、解释文本、截断等模型输出错误保留原文、usage 和哈希，记为 invalid，并继续其他槽位。服务访问或供应商协议错误会停止本轮以免连续消耗预算。
- v2 与 v3 的提示词、依赖或验收不同，结果不得合并排名。先试跑，再以完整冻结配置运行 21 用例、63 次请求；源码、原始响应、提示词与逐例结果全部保留。

构造函数中的直接字段赋值，以及只被字段初始化使用的私有工厂（一层调用）现在会归属于服务字段；不把它们误判成请求内创建，也不会漏掉该字段的关闭检查。普通方法重复调用、局部变量遮蔽、延迟 lambda 均保留请求内创建风险。历史试跑评分在重算前单独备份，重新评分不产生模型请求；全量轮次使用冻结后的分析器。

CASE-012 的 PoC 超时语义明确为 2 秒上限、TimeoutException 异常完成，并保持正常 quote-<orderId> 返回值。该约定是共享的任务验收条件，不是仅对某一种策略注入的规则。


## v4：全量实验后的修正与定向复验

v3 已完成 21 用例 × 3 策略的 63 次真实调用，共 126328 usage.total_tokens；原始报告保留在 `.eval-cache/deepseek-v3-full/`。原始编译成功数为 Baseline 21、RAG 21、Rules 17，原始功能成功数为 20、20、16。所有任务清单仍需证据审查，不能宣布完整任务验收通过。

- 修正 TP-SUBMIT-001/005：区分普通 Future 与 CompletableFuture API；未捕获异常处理器属于 Thread，由 ThreadFactory 设置，ThreadPoolExecutor 没有此方法。处理器不能代替 submit 的 Future 异常处理。
- CASE-007/009 从对象相等比较改为读取实际拒绝计数并检查增量；允许计数、告警后传播 RejectedExecutionException。未知统计格式为 unavailable。新增反例测试，阻止新建统计对象却不增加计数的假通过。
- CASE-016 明确独立 Spring context 的依赖要求及原公开无参入口；CASE-020 明确补齐输入片段引用的 pendingReports 字段。这些约定对所有策略相同，不给原始失败代码补桩。
- 配置可指定 `strategies` 子集（baseline/rag/rules，唯一且非空）用于定向复验。省略时仍运行三组；定向结果必须单独标明策略、用例和调用数，不能拼接成新一轮完整对比。
- 本次定向计划：Rules 的 CASE-005/007/011 共 3 次，全部策略的 CASE-016/020 共 6 次。旧源码拒绝测试另做零调用复验，保存到独立 JSON，不覆盖原 v3 报告。全量结果的后续分析不能将测试修正和新生成源码混为同一轮提升。


v4 首批定向产出另暴露两处接口适配问题：Spring stats 重载选择现在只接受无参入口或接收实际 Bean 的静态单参入口，并优先无参入口；不把 stats(String) 当作 stats(bean)。CASE-020 的 pendingReports 明确为 Queue<String>，支持原始代码的 offer 调用（Collection 没有 offer）。首批定向原始失败结果保留，Spring 用相同源码零调用复验；导出仅对受影响的 Baseline/RAG 各新增一次生成。这两次为独立的 follow-up，不并入首批 9 次结果。


## 核心流程审查后的实验边界

规则预算、排序、提示词、RAG 文档范围及校验器均已调整，见 [核心审查](../docs/ENGINE-REVIEW.md)。此前 v3/v4 原始结果继续保留；当前版本的零调用分析不是新的生成对比。参考用例修正不回写历史 prompt 或模型源码。后续生成须使用新目录与冻结配置，不能与旧轮拼接。

## v5：核心重构后的首次生成与修复实验

首次生成仍为 21 × 3 = 63 次，使用相同的当前输入、共享交付约定、依赖与验证器；prompt 和规则预算按重构后的引擎生成。v5 与旧 v3/v4 不能直接作因果归因。真实模型为 deepseek-flash，temperature 0、thinking disabled、不发送 seed，完整原始响应及使用量保留。

首次报告完成后，`node eval/repair-experiment.ts FIRST_RUN OUT_DIR 12` 对 Rules 的编译、功能、公开 API 或 error 规则失败项作独立修复。全局最多 12 次额外调用，每例最多 2 次，编译失败优先；对模型返回仅提取单一源码块，不自动改源码。独立 `first-pass-api-audit.json` 覆盖三种策略；结构检查保护原公开方法、静态属性、包名及公开构造，不替代完整源码兼容性/业务审查。修复提示包含原始输入、共享交付约定及真实诊断。

修复调用开始前落盘，供应商失败立即停止，不自动重试；已有目录禁止覆盖。初次源码及报告只读，每个候选、检查与调用单独保留。修复程序必须匹配首次轮次的代码 diff、未追踪文件哈希、原始源码哈希及 provenance。达到全局上限的未处理用例仍列在 remaining_cases，不能计为通过。通过指编译、当前可信行为断言、API 结构和 error 规则门控通过，不等于完整任务清单已验收。

v5 首轮结束后，针对上下文检查的修正另建单例轮次。`--revised-engine CASE-020` 只用于显式标记的新代码/测试复验；原始父轮 provenance 和源代码哈希仍须吻合，同时保存本轮工作区 diff 和未追踪文件哈希。默认模式仍拒绝代码变更。该模式的结果不能回填父轮或声称三组公平比较。实际调用及结果见 [V5-RESULTS.md](V5-RESULTS.md)。

后续任务门控升级：修复目标包含 task_check=failed；revised-engine 显式选中的用例会重新运行当前验收。真实修复适配器显式返回 Verification.task；当前仅 CASE-006/019 的确定性断言覆盖各自已冻结的任务清单，其他用例须绑定源码哈希的完整审查，否则为 unverified。失败审查优先于局部测试，诊断保留不通过的具体证据；每次修改后重新核对哈希，不能继承旧审查。通过语义必须按具体轮次及其代码快照理解，不能把此升级套用到早期 passed 记录。CASE-006 契约及轮次详见 [PRIORITY-RESULTS.md](PRIORITY-RESULTS.md)。

随后 CASE-017 也纳入冻结契约的确定性任务门控，观察注入下游的真实虚拟线程调用、限流与生命周期，不再只检查无关执行器身份。经用户确认完成两次模型修复，第二次使用上一候选作单次有界继续修复；旧 checker 的误报与零调用复验分开保留。范围与边界见 [VIRTUAL-RESULTS.md](VIRTUAL-RESULTS.md)。

CASE-020 后续使用注入 generator 与 timeoutMillis 的独立验收，观察实际阻塞任务退出、排队任务取消、强制关闭解放等待调用者及上下文恢复。该变更最初仅作本地实现与验收，0 模型调用；后续独立模型修复与审查记录见导出结果文档。仍需源码哈希绑定的任务审查证明 CompletableFuture 结果编排，不能仅凭运行返回正确就自动计完整任务通过。新接口约定与新测试不能回填旧比较，见 [EXPORT-RESULTS.md](EXPORT-RESULTS.md)。

2026-10-21 对参考集单独进行编译/静态/运行探针审计，补齐 16 份参考片段缺失的 logger 与队列声明。20 份 good.java 与 CASE-019 的 before.java 负对照均可编译；14 份仍有空方法。该审计不读取、覆盖或重算历史模型结果，不产生模型调用，逐项覆盖和优先级见 [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md)。后续三组比较必须冻结共同的任务契约和验证器，参考集探针通过不能计为模型业务完成。


### 已记录候选的延续修复

`node eval/repair-experiment.ts FIRST_RUN NEW_OUT 2 --revised-engine CASE-020 --continue-from PREVIOUS_REPAIR` 从之前修复目录的最终已验证候选继续。校验它属于同一首次实验、result 最终源码、候选文件及检查哈希一致，输出新目录并记录父轮清单、result 与起始源码哈希；不会覆盖任何历史证据。已有传入预算仍控制调用总量，每例至多两次，相同候选停止。

程序化 `runRepairExperiment` 另支持 `reviewsDir`，指向以 CASE-ID.json 命名的 TaskReview 目录；用于源码审查反馈与最终验收，保存各审查哈希。审查必须对应每份候选的源码哈希，新源码不会继承旧审查的通过。CASE-020 独立执行排队关闭与不可中断关闭检查，避免更早的断言遮住其他失败。测试失败与源码审查介入后的修复结果须单独报告，不能并入原始三策略公平比较。


### CASE-004：真实重试与周期异常隔离

CASE-004 改为独立 Java 验收，通过 `(long initialDelayMillis, long delayMillis, Consumer<String> retryHandler)` 注入真实重试回调，避免等待原先 30 秒周期。无参构造保留，但没有下游配置时明确拒绝调度；公开三参构造拒绝 null 回调。固定延迟按上轮完成计算，首轮异常后须继续多轮且不影响另一订单，关闭/中断与拒绝补偿分别验证。接口约定由 delivery-contract.ts 同样提供给全部策略，新增约定后的定向修复不回填旧公平比较。

`acceptanceScenarios` 声明可独立执行的业务场景，修复适配器即使遇到早期配置失败，也收集其他回调、延迟及关闭失败。CASE-004 的两条任务清单由实际注入回调验收覆盖，可在全部检查通过后计 scoped task 成功；它不表示真实支付系统已经接入。其余任务仍沿用各自审查要求，尤其 CASE-020 不能仅凭运行检查替代结果数据流审查。

TP-SUBMIT-005 扩展周期任务异常保护：提交外层 catch 和线程异常处理器不能维持周期；静态检查辨认整体 try/catch、私有 helper、重抛与参数求值边界。该结构检查保留保守 warning，未知 Runnable/方法引用等路径须另验，不能当作完整异常控制流证明。详见 [RETRY-RESULTS.md](RETRY-RESULTS.md)。

## 已审查但证据不足

源码审查记录允许显式表达无法验证的冻结条目：`passed: null`、`verdict: "unverifiable"`，同时仍须提供非空 `evidence`、审查者和正确的源码 SHA-256。普通审查模板里的 null 没有 verdict/evidence，仍属于未完成记录。只要存在已确认失败，任务状态为 failed；其余条目有证据不足时保持 not_run，并在 detail 中说明已经审查及证据缺口，不能转成成功。

完整清单审查覆盖率与任务成功率应分开报告。Agent 审查须明确署名为 Agent，不能声称是人工验收。空业务方法可能反映原始 PoC 没有定义可观察的业务契约；应记录为无法验证，不凭空要求一个未定义的生产接口，也不通过线程池任务计数推断外部业务已完成。

当前 CASE-005 验收还会用真实等待任务填满队列，验证非核心线程确实创建，并在临时缩短 keepAlive 观察间隔后验证回收，最后恢复原配置。这是加强后的验收，不能覆盖此前仅检查配置的冻结结果。
