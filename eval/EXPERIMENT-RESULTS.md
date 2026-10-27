# DeepSeek 实验结果与失败项修正

模型为 deepseek-flash，temperature=0，thinking disabled；DeepSeek 不支持固定 seed，不能声称逐 token 可复现。源码不自动修复，依赖为固定版本的真实 Java/Spring/Micrometer/SLF4J。各轮原始 prompt、响应、调用参数、usage、源码哈希、报告均在 `.eval-cache` 的独立目录内；该目录被 Git 忽略，下面的摘要用于保留仓库内可审查结论。

## v3 完整三策略实验：原始记录

21 用例 × 3 策略，63 次生成均返回完整输出，共 126328 usage.total_tokens。原始报告 `.eval-cache/deepseek-v3-full/report.json` 的 SHA-256 为 `8b06d90f7706cf5f90e53159fea741ed0fe8a463ff58255838c98d102bb3903b`，修正后未覆盖。

| 策略 | 编译通过 | 原始功能检查通过 | error 实例 | 全部违规实例 | usage.total_tokens |
| --- | --- | --- | --- | --- | --- |
| Baseline | 21/21 | 20/21 | 27 | 53 | 24051 |
| RAG | 21/21 | 20/21 | 19 | 43 | 46820 |
| Rules | 17/21 | 16/21 | 7 | 54 | 55457 |

这些数字不是完整任务验收结果。所有任务清单审查仍为 not_run；功能断言仅覆盖部分任务行为。Rules 的 error 数较少，但编译退化，不能据此宣布其优于 RAG。

原始失败项与定位：

- Baseline CASE-007：已有拒绝计数及告警，但测试错误地拒绝了继续传播 RejectedExecutionException 的合法行为。修正测试后同一源码通过。
- Rules CASE-005/007/011：调用不存在的 ThreadPoolExecutor.setUncaughtExceptionHandler。规则 TP-SUBMIT-001/005 的文字没有明确 API 所属类型，现已纠正，并区分普通 Future 与 CompletableFuture API。
- RAG/Rules CASE-016：独立 Spring context 中没有 MeterRegistry Bean；并有公开无参构造或 orderNotifier() 签名变化。共享交付约定已明确独立容器依赖要求和原接口。
- Rules CASE-020：引用未声明的 pendingReports。交付约定明确补齐该字段，且使用支持原始 offer 调用的 Queue<String>。

旧源码拒绝测试的零调用复验位于 `.eval-cache/deepseek-v3-full/rejection-recheck-v4.json`：Baseline/RAG 的 CASE-007/009 与 Rules CASE-009 均通过；Rules CASE-007 保留原编译失败。原始报告没有重算或改写。

## v4 定向复验：保留各轮失败，不合并排名

| 独立轮次 | 范围 | 新调用数 | tokens | 首次原始检查结果 |
| --- | --- | --- | --- | --- |
| deepseek-v4-rules-api | Rules CASE-005/007/011 | 3 | 8336 | 3/3 编译和功能通过 |
| deepseek-v4-contracts | 全策略 CASE-016/020 | 6 | 15929 | 4/6 编译通过、3/6 功能通过 |
| deepseek-v4-export-followup | Baseline/RAG CASE-020 | 2 | 4971 | 两例编译检查超时，未执行功能测试 |

本次新增调用共 11 次，29236 tokens；没有自动重试模型、替换失败源码或回填旧报告。三个轮次的生成记录与 manifest 哈希一致，provenance 检查均通过。

首批定向复验暴露的两个适配问题也已修正：Spring 测试选择了不兼容的 stats(String) 重载，现优先无参入口或接收实际 Bean 的静态入口；最初新增的 Collection<String> 字段约定没有 offer 方法，现纠正为 Queue<String>。后者导致首批 Baseline/RAG CASE-020 编译失败，因此只对这两项另建 follow-up，不重跑整个实验。

修正重载选择后，一次 Spring 本地复验超时；45 秒诊断检查通过，该诊断不计为原预算下成功。随后使用原 10 秒限制串行复验：三个 CASE-016 与两个 follow-up CASE-020 均编译、功能通过，每项总耗时约 2.6–3.3 秒；首次超时记录保留，不归因为已证实的源码错误，也不隐藏此次不稳定性。零调用复验文件：

- `.eval-cache/deepseek-v4-contracts/spring-overload-recheck.json`：首次修正测试后的结果，含超时。
- `.eval-cache/deepseek-v4-contracts/spring-timeout-diagnostic.json`：延长限制的诊断，独立标记。
- `.eval-cache/deepseek-v4-contracts/local-recheck-final.json`：原 10 秒限制，三例通过。
- `.eval-cache/deepseek-v4-export-followup/local-recheck-final.json`：原 10 秒限制，两例通过。

结合 API 轮次三例和首批 Rules CASE-020，受影响的 9 个策略/用例各有一份最新产出通过编译与当前功能断言。11 次生成中仍保留两份早期 Collection.offer 编译失败源码；这不是“11/11 首次成功”，也不能拼接为新的 21 用例三策略成功率。AST 接口审查确认这三轮产出的原公开方法及无参构造均保留。

## 剩余工作

- 逐项审查 63 份完整实验产出的任务清单并绑定源码哈希。尤其补强 CASE-006 优先级/淘汰顺序、CASE-017 下游限流、CASE-020 异常上下文/取消路径的测试。
- 继续检查剩余规则违规：API 定向三例仍有监控和未执行任务处理的警告；Spring 定向 Baseline 有 2 个 error，Rules 有 1 个 error，需要区分真实问题和分析器限制。
- 全量失败修复、业务验收和新的冻结实验完成前，不宣布 Phase 1 完整验收通过，不以定向复验替代完整对比。

实现细节、运行命令及指标口径见 [PROTOCOL.md](PROTOCOL.md)。

## 本地验证

最终 `npm run typecheck` 和 `git diff --check` 通过；配置真实 Java 21 与固定依赖 classpath 后，`npm test` 共 85 项通过、0 失败、0 跳过。日志保留在 `/tmp/ontology-v4-final-tests.log`。回归包含合法拒绝异常传播、统计对象身份误判、Thread/Executor API 归属和 Spring stats 重载选择。

核心重构后的 v5 新轮结果及修复闭环见 [V5-RESULTS.md](V5-RESULTS.md)。v3/v4 原始记录保持不变。
