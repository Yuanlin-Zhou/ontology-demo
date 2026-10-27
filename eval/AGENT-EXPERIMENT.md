# Agent 对比实验

本流程使用 OpenAI-compatible Chat Completions 接口，比较 baseline、BM25 RAG 和语义规则召回。模型、任务、系统提示词、temperature、输出上限和知识预算在三组间保持一致；按用例与重复轮次轮换调用顺序。每次使用独立上下文，只有一次生成，不向模型提供测试源码、参考实现或校验结果。

## 运行

在仓库根目录执行：

```bash
npm ci
npm run setup:java
npm run typecheck
npm test
# 由环境注入 EVAL_API_BASE / EVAL_API_KEY，切勿把密钥写进配置或版本库。
npm run eval:agent -- eval/agent.config.example.json
npm run eval:boundaries
```

`setup:java` 优先使用 JAVA_HOME、项目 `.tools/jdk` 或系统 javac；都没有时，通过 apt-get download 和 dpkg-deb 在项目内安装 OpenJDK 21，无需 root。Java 校验器会优先选择 JAVA_HOME 或项目 JDK。Node 需支持 `--use-env-proxy`（当前环境 v24.19.0），保留环境代理与证书设置。

配置字段：`casesDir`、`outputDir`、`model` 必填；`temperature` 默认 0，`maxTokens` 默认 4096，`tokenBudget` 默认 1200，`repetitions` 默认 1；可用 `caseIds` 选择用例。`baseUrl` 可覆盖 `EVAL_API_BASE`，应为 API 根路径，如 `https://api.deepseek.com` 或其他服务的 `https://host/v1`。示例执行 4 个任务 × 3 种策略 × 3 轮，共 36 次模型请求。

每个输出目录保留 manifest、逐次 prompt、原始响应、生成 Java、provider usage、诊断、逐次结果和汇总报告。完成响应自动缓存，重复运行同一配置不会重复调用已缓存请求；网络失败无响应时可重试。配置、任务、参考实现、行为测试、规则或语料变化后，应使用新目录，混合实验会被拒绝。不要手工覆盖 manifest 来复用旧响应。

## Java 功能契约

新增 `eval/agent-cases` 有四个独立任务：异步通知与失败隔离、Future 超时和取消、复用线程的上下文恢复、优雅关闭及中断恢复。每个任务固定接口、`verification.json`、隐藏于模型的 `Harness.java` 和人工参考实现。运行前用参考实现验证测试契约；测试成功后才请求模型。

生成源码用真实 `javac --release 21` 编译，再执行固定 main 测试；编译超时 20 秒、行为执行超时 12 秒，JVM 有内存和 CPU 数量限制，临时文件结束后清理，子进程不继承模型密钥、代理和 JVM 注入配置。这是受控评测运行器，不是任意不可信 Java 的安全沙箱。

新增用例可复制该目录结构。`verification.json` 指定生成文件名 `source`、行为入口 `main`、测试文件 `harness`，以及可选的 `support` Java 文件。外部依赖不自动伪造。原有 21 个静态用例可作为 casesDir 生成，但无行为契约时行为记为 unavailable，不能计算为任务完成。

## 指标与口径

- 规范遵循率：`1 - 违反的不同规则数 / 检查的不同规则数`，包含 info 级规则；重复违规不重复扣同一规则的分。语法错误或无适用规则时记为未评分，同时显示评分覆盖数。它是当前静态检查器的估计，不是人工正确性结论。
- 违规数：保留全部 finding，可区分规则 ID、严重级别和行号。
- 编译率：真实编译成功次数 / 全部尝试次数，失败生成仍进入分母。
- 任务完成率：编译成功且固定行为断言全部通过 / 全部尝试次数，缺少测试契约不算完成。
- token 成本：provider 实际返回的 prompt、completion、total token 总数，明确显示 usage 覆盖数；知识和完整 prompt 的本地估算另存，不冒充真实用量。没有设置价格，不推算货币成本。

原有 `eval --agent-results` 也改为执行真实 javac。缺少 JDK 记 unavailable；缺少第三方依赖或源码不合法记 failed。原有流程没有固定行为测试或 provider usage，完整对比请使用本流程。

## 独立范围验证

`eval/fixtures/boundaries.json` 是人工定义的 10 个定向测试，包括容量边界、Future 超时、ThreadLocal 异常清理以及跨文件 helper/工厂。每项只评价指定规则；标注不由引擎输出生成。

两个跨文件案例分别暴露清理 helper 的误报和队列工厂的漏报。它们保留真实标签并参与所有指标分母；报告注明 known limitation，普通回归检查不会把已知局限误当成本次新增缺陷。Apache Commons Lang 的真实代码另作兼容性检查，来源和许可证见 `fixtures/real-world/README.md`。

原有 21 用例的 100% 与独立范围验证的指标属于不同数据集，不应合并为真实项目质量结论。四个功能任务的样本仍然很小；temperature=0 的重复轮次也不等同于独立随机样本，provider 的 model 别名可能随时间变化。需要更多真实业务任务、依赖完整的项目和人工复核，才能判断推广价值。这里验证的是单次模型生成，尚未接入 Cline 工具调用或 Repair 循环。

## 与远端 work 合并后的说明

远端已有完整 experiment / repair-experiment 和 eval/java.ts 编译工具。本功能保留为独立的标准库功能基准，Java 辅助模块命名为 eval/benchmark-java.ts，避免覆盖已有接口。2026-10-27 的结果是在提交 5edb375 对应引擎上产生的历史结果；合并后引擎及规则有变化，开始新实验必须使用新的 outputDir，不复用历史结论。现有完整实验协议请同时参阅 eval/PROTOCOL.md。

## 完整第三方验收环境

```bash
npm run setup:java
npm run setup:eval   # 校验并准备固定版本的 Spring / Micrometer / Jakarta 等依赖
npm run check:eval   # 只检查 JDK 和全部依赖的 SHA-256，不发起网络请求
npm run test:eval    # 配置 EVAL_JAVAC、EVAL_JAVA、EVAL_CLASSPATH 后运行完整测试
```

`test:eval` 的依赖缺失或摘要不匹配时会直接失败，提示重新 setup，不悄悄退回缺依赖模式。`npm test` 保留轻量开发用途；正式验收应使用 `test:eval`，并检查测试汇总中的跳过数。
