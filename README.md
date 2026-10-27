# Knowledge Rule Engine (Phase 1 PoC)

把研发规范从"文档"转成**可计算的原子规则**，再根据当前代码的**语义特征**精准召回少量真正适用的规则，
并在代码生成后做**确定性校验**。对应 `00-overview.md` 的 Phase 1 与 `01-phase1-rule-engine-poc.md`。

```text
Java Code → tree-sitter AST → Semantic Feature → Rule Matcher → Applicable Rules → (Agent) → Validator → Violations
```

PoC 范围（与方案一致）：**Java 单语言 + ThreadPool 单领域 + 26 条 Atomic Rule + 21 个评测用例**，
知识用 YAML 保存，**不依赖 LLM 做分类**，**暂不侵入 Cline**。

---

## 1. 快速开始

```bash
npm install            # 安装依赖（tree-sitter 使用 win32-x64 预编译绑定，无需编译器）
npm run typecheck      # TypeScript 类型检查
npm test               # node:test 单元测试 + 数据集一致性测试
npm run eval           # 运行三方对比评测，产出 eval/report.md 与 eval/prompts/**
```

CLI（等价于 `npm run engine -- <command>`）：

```bash
# 1) 精准召回：代码 → 语义特征 → 适用规则
node src/cli/index.ts retrieve --file samples/bad/OrderAsyncService.java
node src/cli/index.ts retrieve --file samples/bad/OrderAsyncService.java --format json

# 2) 规则校验：定位 + 修复建议（有 error 级违规时退出码 1，可直接用于 CI）
node src/cli/index.ts validate --file samples/bad/OrderAsyncService.java
node src/cli/index.ts validate --file samples/good/OrderAsyncService.java

# 3) 语义特征明细
node src/cli/index.ts features --file cases/CASE-003-unbounded-queue/before.java

# 4) 规则清单
node src/cli/index.ts rules
node src/cli/index.ts rules --domain thread_pool --json

# 5) 生成给 Agent 的 Prompt（rules / rag / baseline 三种策略）
node src/cli/index.ts prompt --file samples/bad/OrderAsyncService.java \
  --task "给 OrderService 增加异步通知能力" --strategy rules --out eval/prompts/manual
```

开发辅助脚本：

```bash
node scripts/analyze.ts samples/good/OrderAsyncService.java --model      # 结构化 model + 特征
node scripts/dump-tree.ts samples/good/OrderAsyncService.java --depth 9  # tree-sitter AST
node scripts/features.ts                                                # 语义特征目录
```

---

## 2. 目录结构

```text
knowledge/                         Atomic Rule 仓库（YAML）
├── schema/rule.schema.json        Rule JSON Schema（01-phase1 §4 的超集）
└── java/thread_pool/
    ├── create.yaml                TP-CREATE-001..005
    ├── config.yaml                TP-CONFIG-001..006
    ├── submit.yaml                TP-SUBMIT-001..005
    ├── rejection.yaml             TP-REJECT-001..005
    └── shutdown.yaml              TP-SHUTDOWN-001..004 + TP-MONITOR-001

src/
├── domain/        types.ts（领域类型）、features.ts（语义特征目录，27 个特征）
├── analyzer/      java-parser（tree-sitter 封装）、ast-utils、model（结构化事实）、
│                  model-builder（两次 AST 遍历产出 model）、feature-detector（特征 + 证据）
├── matcher/       rule-repository（加载/校验）、rule-matcher（feature → rule）
├── validator/     validator-registry、checks/thread-pool-checks（26 个 checker）、rule-validator
├── retrieval/     token-estimator、rag-baseline（BM25 对照基线）、prompt-renderer
├── api/           engine.ts（retrieve / validate / analyze / buildPrompt）、index.ts
└── cli/           index.ts（retrieve | validate | features | rules | prompt | eval）

cases/CASE-0xx/                    评测用例：case.yaml + before.java + bad.java + good.java
eval/                              runner / metrics / cases 加载 / report.md / report.json / prompts/**
samples/                           手工演示用的坏/好实现
tests/                             node:test 单测（analyzer / knowledge / validator / retrieval / cases）
scripts/                           开发工具（analyze / dump-tree）
```

---

## 3. 架构与数据流

1. **Analyzer**：`parseJava()`（tree-sitter-java）→ `buildThreadPoolModel()` 两遍遍历：
   - 声明遍：线程池创建（`ThreadPoolExecutor` / `ScheduledThreadPoolExecutor` / `Executors.*` /
     Spring `ThreadPoolTaskExecutor` + setter / 虚拟线程执行器）、队列、线程工厂、拒绝策略、
     变量类型表、自定义 `ThreadFactory` / `RejectedExecutionHandler` 实现、注解（`@Bean` / `@PreDestroy` / `@Async`）。
   - 使用遍：`submit/execute/invoke*/schedule*`、`shutdown/shutdownNow/close/awaitTermination`、
     `Future.get/join`、`CompletableFuture.*Async`、`ThreadLocal/MDC`、监控 getter、`InterruptedException` 捕获。
2. **Semantic Feature**：`detectFeatures()` 由 model 派生特征，每个特征带**证据**（行列 + 片段 + 置信度 + 属性）。
3. **Rule Matcher**：`applies_when` 用确定性集合运算匹配（`features` = AND，`any_features` = OR，`none_features` = NOT），
   按 priority/id 排序，可选 `related_rules` 扩展与 token 预算裁剪。
4. **Validator**：只跑**适用规则**的命名 checker（`rule.check.validator`），产出
   `rule_id + message + severity + line/column + snippet + suggestion`，供 Agent 直接修复。

---

## 4. Atomic Rule 格式

`knowledge/java/thread_pool/*.yaml` 每个文件是一个规则数组；字段定义见 `knowledge/schema/rule.schema.json`：

```yaml
- id: TP-CONFIG-004                       # 全局唯一，一条规则只表达一个约束
  name: 任务队列必须有界
  domain: [java, concurrency, thread_pool]
  language: java
  severity: error                        # error | warning | info（validate 的违规级别）
  priority: critical                     # critical | high | medium | low（召回排序）
  applies_when:                          # 何时适用（确定性，不含 LLM 判断）
    features: [THREAD_POOL.CONFIG.QUEUE]
  description: 阻塞队列必须有明确容量，禁止使用无界队列作为任务缓冲。
  content: |                             # 注入 Agent 的规则正文
    ...
  rationale: |                           # 为什么（可选，--rationale 时一起注入）
    ...
  check:                                 # 确定性检查器（可选；没有 check 的规则只召回不校验）
    validator: thread_pool.queue_bounded
    params: {}
  examples:                              # 正反例（必填，且被单测强制校验）
    positive: [{ note: ..., code: | }]
    negative: [{ note: ..., code: | }]
  related_rules: [TP-CONFIG-005, TP-REJECT-001]
  references: [java-thread-pool-best-practices.md §有界队列应该设置多大？]
  tags: [thread-pool, queue, oom]
```

规则仓库加载时做完整性校验（重复 id、`related_rules` 悬空、非法/未知特征、缺失必填字段、
severity/priority 枚举），任何问题都会以 `RuleValidationError` 抛出并列出全部问题。

### 新增一条规则的步骤

1. 在 `src/domain/features.ts` 增加特征（如果现有特征无法表达"何时适用"）。
2. 在对应 YAML 增加规则（id / applies_when / content / check / examples / references）。
3. 若需要新的可执行约束，在 `src/validator/checks/thread-pool-checks.ts` 用
   `registerValidator('thread_pool.xxx', ctx => findings)` 注册 checker，并让 `check.validator` 指向它。
4. 在 `cases/` 增加用例（`before.java` 期望特征/规则、`bad.java` 期望违规、`good.java` 必须 0 error），
   `npm test` 会自动校验三张表的一致性。

### 26 条 Atomic Rule 一览

| 文件 | 规则 |
| --- | --- |
| create.yaml | TP-CREATE-001 显式创建（禁止 Executors 快捷工厂）、TP-CREATE-002 禁止请求内重复创建、TP-CREATE-003 必须配置线程工厂、TP-CREATE-004 自定义工厂必须命名、TP-CREATE-005 容器托管生命周期 |
| config.yaml | TP-CONFIG-001 核心线程数显式且 >0、TP-CONFIG-002 最大线程数有界、TP-CONFIG-003 keepAliveTime 匹配、TP-CONFIG-004 队列必须有界、TP-CONFIG-005 队列容量可控、TP-CONFIG-006 禁止 DiscardOldest+优先级队列 |
| submit.yaml | TP-SUBMIT-001 submit 返回值必须处理、TP-SUBMIT-002 Future.get 必须带超时、TP-SUBMIT-003 CompletableFuture 必须指定 Executor、TP-SUBMIT-004 ThreadLocal 必须清理、TP-SUBMIT-005 任务异常必须处理 |
| rejection.yaml | TP-REJECT-001 必须显式配置拒绝策略、TP-REJECT-002 禁止静默丢弃、TP-REJECT-003 必须处理 RejectedExecutionException、TP-REJECT-004 CallerRunsPolicy 需评估调用线程、TP-REJECT-005 自定义拒绝策略必须上报 |
| shutdown.yaml | TP-SHUTDOWN-001 应用级线程池必须关闭、TP-SHUTDOWN-002 优雅关闭需 awaitTermination、TP-SHUTDOWN-003 必须恢复中断状态、TP-SHUTDOWN-004 shutdownNow 返回值必须处理、TP-MONITOR-001 线程池必须可观测 |

---

## 5. 语义特征目录（27 个）

| 分组 | 特征 |
| --- | --- |
| create | `THREAD_POOL.CREATE`、`CREATE.EXECUTORS_FACTORY`、`CREATE.PER_REQUEST` |
| config | `CONFIG.CORE_SIZE`、`CONFIG.MAX_SIZE`、`CONFIG.KEEP_ALIVE`、`CONFIG.QUEUE`、`CONFIG.REJECTION`、`CONFIG.THREAD_FACTORY` |
| submit | `SUBMIT`、`EXECUTE`、`FUTURE.GET`、`COMPLETABLE_FUTURE` |
| exception | `EXCEPTION`、`EXCEPTION.UNCAUGHT_HANDLER` |
| shutdown | `SHUTDOWN`、`SHUTDOWN_NOW`、`AWAIT_TERMINATION` |
| threadlocal | `THREAD_LOCAL` |
| monitor | `MONITOR` |
| scheduled | `SCHEDULED` |
| custom impl | `THREAD_FACTORY.CUSTOM_IMPL`、`REJECTION.CUSTOM_IMPL` |
| spring | `SPRING.ASYNC`、`SPRING.EXECUTOR_BEAN`、`SPRING.PRE_DESTROY` |
| virtual thread | `VIRTUAL_THREAD` |

其中前 8 个对应 `01-phase1 §5` 的最小集合，其余是为了让 `applies_when` 更精确而补充（均来自两篇线程池知识文档）。

---

## 6. API 契约

```ts
import { RuleEngine } from './src/api/engine.ts';

const engine = RuleEngine.load();                       // 加载 knowledge/ 下的规则

const retrieved = engine.retrieve({ code, filePath, task, includeRelated: false, tokenBudget: 1200 });
// → { features, feature_details, rules, stats: { candidate_rules, matched_rules, estimated_tokens, ... } }

const validated = engine.validate({ code, filePath, ruleIds? });
// → { status, checks, features, checked_rules, violations: [{ rule_id, message, severity, line, column, snippet, suggestion }] }

const prompt = engine.buildPrompt({ task, code, filePath, strategy: 'rules' | 'rag' | 'baseline', tokenBudget });
// → { prompt, estimated_tokens, context_tokens, features?, rule_ids?, chunks? }
```

修复闭环通过 `engine.repair({ task, code, verify, generate, maxRepairs })` 调用；详见核心审查文档中的适配示例。
`verify` 可返回独立的 `task` 状态：完整任务验收失败也会触发修复，尚未验收则返回 unverified。CASE-006 已补真实优先级、淘汰与生产参数验收，过程及证据见 [业务修复记录](eval/PRIORITY-RESULTS.md)。
CASE-017 已补真实虚拟线程下游回调、限流、异常释放与重复关闭验收，完成两次有界模型修复，并修正私有等待 helper 的静态误报；见 [限流验收记录](eval/VIRTUAL-RESULTS.md)。
CASE-020 已补实际任务取消、上下文恢复、排队回收与关闭验收，并区分同步 CompletableFuture 编排和异步调度；定向模型修复现已通过运行验收，另保留源码审查及零调用复验记录。见 [导出取消记录](eval/EXPORT-RESULTS.md)。
21 用例的编译、规则、正常/异常/关闭覆盖与剩余缺口现统一记录在 [验收矩阵](eval/ACCEPTANCE-MATRIX.md)。参考输入均可编译并通过当前探针，14 份仍含空方法；这不是完整业务通过或模型生成成功率。

Phase 2 可以把 `engine.retrieve` / `engine.validate` 包装成 Cline 的
`knowledge_retrieve` / `knowledge_validate` 两个工具即可（同一进程内的 TS 模块，无需跨进程桥接）。

---

## 7. 评测方法与结果

`npm run eval` 对 21 个用例跑三种策略（`baseline` 无知识、`rag` 文档 BM25 片段、`rules` 本引擎）：

```text
| Strategy | Rule P | Rule R | Rule F1 | Feature P | Feature R | Ref Recall (RAG) | Avg Context Tokens | Avg Budgeted Tokens | Avg Rules |
| baseline |  n/a   |  n/a   |   n/a   |    n/a    |    n/a    |       n/a        |          0         |          0          |     0     |
| rag      |  n/a   |  n/a   |   n/a   |    n/a    |    n/a    |      20.5%       |        1181        |        1181         |     0     |
| rules    | 100.0% | 100.0% | 100.0%  |  100.0%   |  100.0%   |       n/a        |        1211        |        1011         |    14.8   |
```

- **Retrieval Precision / Recall / F1**：期望规则集 vs 召回规则集（不施加 token 预算，预算只影响注入成本）。
- **Feature P/R/F1**：期望语义特征集 vs 抽取特征集（衡量 Analyzer 精度）。
- **Ref Recall (RAG)**：期望规则 `references` 指向的知识章节中，有多少真的被 RAG 召回——同等 token 成本下
  普通 RAG 只覆盖约 20%，而规则召回直接给出可执行的约束文本。
- **Context Token Cost**：注入知识的 token（估算规则：CJK 按 1 token/字，其它按 4 字符/token）。
- **validate**：`bad.java` 上违规级 precision/recall（21 个用例 100%/100%），
  `good.java` 上必须 0 个 error（19 个合规文件 0 误报）。
- **Rule Compliance Rate / Compile Rate / Test Pass Rate**：需要 Agent 产出，见下。

### Agent 在环回填流程

```bash
npm run eval -- --out .eval-cache/experiment-run
# 把 prompt 交给 Cline 执行，把产出的 Java 代码放到 .eval-cache/experiment-run/results/<strategy>/<caseId>.java
node src/cli/index.ts eval --agent-results --out .eval-cache/experiment-run
```

`--agent-results` 按非 info 的已检查规则与违规规则去重计算 **Rule Compliance Rate**，同时保留违规实例数；无适用规则或源码语法错误时为 `n/a`。
生成响应可按协议提取唯一的 Java Markdown 代码块，保留原文和提取哈希，不改动 Java 逻辑。现在会真正调用 Java 21 `javac` 编译产出，记录编译诊断、工具不可用和超时；可通过 `--javac`、`--java`、`--classpath`、`--release`、`--timeout-ms` 配置。
21 个用例均已提供功能/运行行为断言，但尚未覆盖全部业务与异常分支。任务完成度需绑定源码哈希、逐项填写验收证据，不能用规则合规率代替。

完整实验协议、21 个任务的验收清单、模型执行器与使用方式见 [eval/PROTOCOL.md](eval/PROTOCOL.md)。已完成核心重构后的 v5 三策略、21 用例、63 次真实生成，首次编译通过数为 21/21、21/21、20/21，后续修复独立记录；见 [v5 结果](eval/V5-RESULTS.md)。历史 v3 的首次编译为 21/21、21/21、17/21，原始记录保留。全量任务清单审查尚未完成，现有结果不支持宣称 Rules 普遍优于 RAG。协议 v4 修正规则 API 说明与拒绝计数测试，并支持独立标记的定向复验。

### 用例期望值是怎么来的

- 期望的**语义特征**：按用例代码人工判定（与引擎实现相互独立）。
- 期望的**规则集**：由 `applies_when` 语义人工推导。
- 期望的**违规集**：由规则语义人工推导。

三者由 `tests/cases.test.ts` 强制精确比对；过程中修掉了 6 个真实引擎缺陷（见 §9），
期间也逐条复核过"是引擎错"还是"期望写错"。

---

## 8. 当前边界与核心审查

核心流程已完成一次结构性审查，修复了作用域混淆、Spring setter 丢失、全文件监控/异常掩盖、预算低估及校验覆盖失真，并增加编译/业务门控的有限修复接口。问题、修复、回归及取舍见 [docs/ENGINE-REVIEW.md](docs/ENGINE-REVIEW.md)。

- 分析限于文件内词法符号、明确类型及有限的单一赋值/工厂追踪，不是完整 Java 类型检查或控制流证明；跨文件继承、复杂别名、反射及深层调用链不分析。
- 监控按具体线程池关联，支持明确的一层 delegate 和单一兼容 Bean 的静态 stats(bean)；未知/多义关联仍需审查。
- Spring 默认销毁和 Java 21 ExecutorService.close() 的等待语义得到认可；不要求重复手工关闭。调度池内部无界队列的容量仍无法靠 setter 改变。
- `validate` 只验证适用规范；语法无效或 checker 不可用有独立状态，不等于编译和业务正确。`engine.repair` 要求宿主提供真实编译、业务测试和模型适配器，未执行检查返回 unverified。
- tokenBudget 是完整知识文本的**估算 token 上限**，不是供应商精确 token 数。默认不扩展关联规则；省略规则有明确元数据。语法错误时暂停规则注入。
- 仍只覆盖 Java ThreadPool 的 26 条规则；完整任务验收与新的模型成功率需要另外验证。

---

## 9. 实现过程中修掉的真实缺陷（回归测试已覆盖）

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| `Integer.MAX_VALUE` 解析不出数值，`TP-CONFIG-002` 漏报 | 先去掉数字分隔符 `_` 再匹配，把 `MAX_VALUE` 也改坏了 | 先精确匹配 `Integer.MAX_VALUE`，再处理 `1_000` / 后缀 |
| `keepAliveTime = 0L` 漏报 | 字面量后缀 `L` 未处理 | 去掉 `[LlFfDd]` 后缀后解析 |
| 自定义 `RejectedExecutionHandler`（类名不含 Handler/Policy）识别失败，`TP-REJECT-001` 误报 | 依赖类名启发式 | 按构造参数位置判定（第 6/7 个参数），lambda 按参数个数区分 factory/handler |
| `namedFactory("x")` 未被识别为线程工厂 | 只匹配 `ThreadFactory` 关键字 | 放宽为 `Factory` 命名约定（排除 handler） |
| `@Bean` 中 `return new ThreadPoolExecutor(...)` 被当成请求级线程池，`TP-CREATE-002` 误报 | 只识别变量声明场景 | `@Bean` 方法中的 return 语句视为容器托管线程池 |
| `finally { restore(previous); }` 形式的 ThreadLocal 清理误报 | 无跨方法推导 | 增加 1 层跨方法清理识别 |

---

## 10. Phase 2 集成建议

- **Tool 化**：`knowledge_retrieve(code, filePath, task?)` / `knowledge_validate(code, ruleIds?)` 直接复用 `RuleEngine`；
  `validate` 的 `suggestion` 字段就是给 Agent 的修复指令。
- **注入位置**：读取代码后（或每轮 edit 前）调用 `retrieve`，把返回的 `rules[].content` 拼进上下文；
  生成后调用 `validate`，把 `violations` 反馈给模型做 Repair 循环。
- **预算控制**：用 `tokenBudget` 控制完整序列化知识文本的估算上限；当前违规优先，具体省略规则通过元数据返回。
- **扩展方向**：新增域只需增加 `knowledge/java/<domain>/*.yaml` + 对应特征与 checker；
  需要跨文件/数据流能力时再引入 CodeGraph，而不是先建图数据库。

---

## 11. 与方案的对应关系

| 方案要求（01-phase1 §11） | 本仓库落地 |
| --- | --- |
| Atomic Rule Repository | `knowledge/java/thread_pool/*.yaml`（26 条）+ `knowledge/schema/rule.schema.json` |
| Java AST Analyzer | `src/analyzer/java-parser.ts`（tree-sitter-java） |
| Semantic Feature Extractor | `src/analyzer/feature-detector.ts`（27 个特征 + 证据） |
| Rule Matcher | `src/matcher/rule-matcher.ts`（AND/OR/NOT + 预算裁剪 + related 扩展） |
| retrieve API | `RuleEngine.retrieve` + CLI `retrieve` |
| validate API | `RuleEngine.validate` + CLI `validate`（退出码可用于 CI） |
| Evaluation Cases | `cases/CASE-001..021`（before / bad / good 三份代码 + 期望表） |
| Baseline / RAG / Rule Retrieval 对比 | `eval/runner.ts` + `eval/report.md`（离线指标已产出，Agent 在环指标待回填） |

CASE-004 已补真实回调重试、异常后继续、固定延迟和关闭验收；周期任务异常保护纳入 TP-SUBMIT-005。定向模型候选通过，详见 [重试验收记录](eval/RETRY-RESULTS.md)。

当前总体结论与冻结后的三策略对比见 [规则引擎现状](docs/RULE-ENGINE-STATUS.md)：Rules 编译 21/21、已配置业务检查 18/21，与 Baseline 持平，静态诊断更少但成本更高；未完成整个 Phase 1 的业务验收。


## 独立功能基准与边界集

新增 4 个标准库 Java 行为任务、10 个独立标注边界案例及 Apache 真实代码兼容性样本，与现有实验和 Repair 流程并存。协议见 [Agent 实验说明](eval/AGENT-EXPERIMENT.md)，历史结果见 [2026-10-27 实验](eval/experiments/2026-10-27/README.md)。

```bash
npm run setup:java
npm run eval:agent -- eval/agent.config.example.json
npm run eval:boundaries
```

完整 Java 验收环境可使用 `npm run setup:eval`、`npm run check:eval`、`npm run test:eval`。它们统一选择 JDK 并校验固定依赖，避免因遗漏 classpath 跳过第三方库行为测试；日常 `npm test` 用法保留。
