# 规则引擎流程审查与修复

目标是让规则知识帮助 Agent 生成可编译、业务正确、符合规范的代码。17/21 的原始编译结果证明该轮 Rules 产出存在实际问题；它不能单独区分知识错误、提示词、模型能力和验收实现的贡献。此次从生产代码全流程定位根因，修复核心能力，没有新增模型实验，也没有重写历史生成代码。

## 结论与架构取舍

保留 tree-sitter 解析器、特征目录、YAML 原子规则和模块接口。主要缺陷位于事实归属、知识序列化、校验覆盖和反馈闭环，替换这些部分比整仓重写更容易验证。新增 `JavaSymbols` 处理文件内词法作用域，预算和渲染共用一份序列化，检索与校验共用分析结果，并补上编译/业务门控的有限修复接口。

现在的调用链：

```text
Java 源码 + 显式计划特征（可选）
  → AST / 词法符号 / 文件内单一赋值与工厂追踪
  → 线程池事实及语义特征
  → 当前违规诊断
  → 匹配规则，优先当前违规，按完整知识文本预算选择
  → 生成提示词（保留接口、功能、真实 API 和依赖约束）
  → 宿主模型适配器返回源码
  → 宿主编译与业务测试 + 全量适用规则校验
  → 失败反馈 / 有限次修复 / 每次重新分析
```

模型调用和真实 Java 环境由宿主适配器提供，核心库不持有密钥。`validate` 是静态规范检查，不是 Java 编译器；`repair` 只有在编译、业务检查均通过且没有 error 规则违规时才返回 passed。warning/info 会完整保留。未执行检查返回 unverified，不能当作成功。

## 已定位并修复的问题

| 环节 | 原问题及影响 | 修复 |
| --- | --- | --- |
| 知识与修复建议 | 上轮修正 YAML 后，checker 的建议仍要求对线程池调用 setUncaughtExceptionHandler，或对普通 Future 链接回调；错误会经反馈再次进入模型 | 统一说明 Thread/ThreadFactory 和普通 Future/CompletableFuture 的 API 边界；真实 javac 与行为测试覆盖反馈修复 |
| 符号与身份 | 全文件按变量名注册，同名局部变量、字段、不同工厂互相污染；任意 execute/submit/shutdown 或看似 pool 的变量也能触发规则 | 基于词法作用域解析声明、遮蔽及明确类型，提交/关闭/监控关联到具体 poolId；推断 lambda 参数也能遮蔽字段 |
| 资源归属 | 构造或工厂返回池被提升为字段后，原局部变量上的 Spring setter 无法回绑，误报无界队列及缺少拒绝策略 | 通过创建节点、单一赋值和明确的文件内工厂追踪资源身份，不依赖最终显示名称；Bean 的延迟 lambda 中创建的池不被当作 Bean 本身 |
| 常量与工厂 | 常量容量不识别；所有 newThreadPerTaskExecutor 被认为虚拟线程；快捷工厂传了 ThreadFactory 仍误报缺失 | 解析 final 整数常量、符号容量和 Integer.MAX_VALUE；区分平台/虚拟每任务执行器，识别实际工厂参数 |
| 匹配与预算 | 静态优先级排序让已满足的约束挤掉实际违规；只算规则正文，忽略标题等；第一条允许突破预算；rationale 开关不一致 | 优先当前违规，共用完整文本序列化，按估算 token 硬预算保留原子规则，支持 0 预算；返回 dropped_rule_ids 和选择告警 |
| 关联规则 | 关联项容易变成无条件额外要求，API 与 CLI 默认值不同 | 默认关闭关联扩展；显式扩展时标为条件建议，尊重排除特征；CLI 与 API 保持一致 |
| 新代码 | 只分析现有源码，无法对空文件表示计划引入的能力 | 提供经过目录校验的 featureHints，单列 planned_features，不伪造已检测到的证据，也不靠任务关键词猜测 |
| 校验覆盖 | 没有 checker、checker 未注册、语法错误仍可能表现为已检查或无违规；显式空 ruleIds 实际检查全部；CLI 语法失败可返回 0 | checked_rules 只记录真正运行的 checker；单列 passed/violated/advisory/unavailable 和 complete/partial/invalid；非法配置加载失败，CLI 无法完成检查返回 2 |
| 多池检查 | 一个池的监控、拒绝策略或未捕获异常处理器影响另一个池 | 逐池关联检查；isShutdown 等状态/配置访问不再冒充运行监控；有限支持单一匹配 Bean 的静态 stats(bean) 入口 |
| Future 与异步 | 保存 Future 就算消费；外层 try 被认为能捕获工作线程异常；二元 Async 重载错误地按两参数判显式 executor | 检查实际消费/委托；按执行边界区分提交异常和任务异常；区分二元 Async 三参数重载；识别有超时保护的 CompletableFuture join |
| ThreadLocal | 任意方法里有 finally/remove 就能掩盖另一个方法的泄漏；同名外部 helper 可误算清理 | 按每次写入及词法符号检查对应 finally，保留明确的一层本地恢复 helper 支持 |
| 生命周期 | awaitTermination 也可能被算成已关闭；其他方法的 await 掩盖当前 shutdown；Java 21 close 误报不等待；强制要求 Bean 再手工关闭 | 区分启动关闭与等待，关联同一资源及同一执行方法；认可 close 的等待语义、Spring 默认销毁和配置等待，禁用销毁时才要求明确责任方 |
| 中断与记录 | 任意 interrupt 或 throw 被认为恢复中断；注释中的 logger 文本可被当成拒绝日志 | 识别 Thread.currentThread().interrupt() 或重抛该异常，记录检查改看实际调用 |
| RAG 对照 | 默认索引了仓库方案和说明文档，且截断文本可能切坏 Java 片段，预算同样允许第一块超限 | 默认只用两个知识原文；完整序列化预算，代码围栏保持原子，超长块跳过；该变化影响未来对照实验，不能沿用旧排名 |
| 修复闭环 | 已有生成、校验能力，但核心 API 没有将编译/业务诊断送回模型的有界流程 | 新增 engine.repair：宿主 verify/generate 回调、maxRepairs 上限、重复候选停机、完整 attempts 记录、每轮重新判断规则适用性 |

原始编译失败中 CASE-020 的未声明业务成员来自单文件交付不足，语义规则本身无法证明业务类型完整。此类问题由编译门控明确拦截，不能通过规则零违规放行。

## 参考用例修正

没有修改历史模型结果。静态参考资料的以下问题单独修正：

- CASE-002 good.java 的 `previous === null` 不是合法 Java，改为 `==`。
- CASE-018 bad.java 确实没有监控第二个池；期望结果补上 TP-MONITOR-001，删除原“文件级监控已知漏报”的注释。
- CASE-021 bad.java 显式禁用 Spring 销毁推断，才构成真正的生命周期反例；期望补上 TP-SHUTDOWN-001。原 before.java 和历史生成输入不变。
- 生命周期规则正例删除了引用未定义 executor 的多余 PreDestroy，避免诱导重复关闭。

## 使用修复接口

```ts
const result = await engine.repair({
  task,
  code,
  maxRepairs: 2,
  tokenBudget: 1200,
  verify: async source => {
    // 宿主使用项目真实 javac/构建器及业务测试，不生成假桩。
    return projectVerifier(source); // { compile, tests, task?, diagnostics? }
  },
  generate: async ({ prompt, attempt }) => {
    return modelAdapter(prompt); // 完整 Java 源码，由适配器规范化响应格式
  },
});
```

`maxRepairs` 只计算额外模型调用，范围 0–10。原代码先验证；没有实际失败但检查不可用时停止并返回 unverified，不盲目消耗调用。超过预算保留最后候选和全部诊断；重复候选返回 stalled。编译或业务失败不能被规则合规率覆盖。宿主还应负责测试隔离、模型调用限时、API 兼容性与真实业务断言，核心接口不臆测这些条件。

宿主可显式设置 `Verification.task`：完整任务验收失败也触发修复，not_run/unavailable 阻止 passed。省略该字段只代表配置的检查完成，不证明完整任务。噪声诊断限长保留异常标题与尾部，避免真实失败原因被日志截掉。CASE-006 的优先级、原子淘汰、生产参数下的拒绝及真实模型复验见 [业务修复记录](../eval/PRIORITY-RESULTS.md)。

CASE-017 的虚拟线程建议已按实际 API 区分：保留合法虚拟线程工厂，监控使用业务计数，不推荐 ExecutorService 上不存在的 ThreadPoolExecutor getter。限流、真实回调与许可释放由独立运行验收验证，见 [限流验收记录](../eval/VIRTUAL-RESULTS.md)。

真实模型复验又发现关闭等待提取到私有 helper 后的误报。TP-SHUTDOWN-002 现能跟随单层、唯一、私有、无参调用，仍要求等待同一资源、调用发生在 shutdown 之后且不在延迟 lambda 内；公共方法、重载歧义、跨资源和参数映射不扩大认可。配套正反例及实际模型候选复验记录保留，未覆盖旧 failed 记录，也未增加第三次模型调用。最新串行全量回归 126/126 通过，0 跳过。

CASE-020 本地取消验收进一步补齐同步 CompletableFuture 特征：thenApply/complete 等操作也记录编排证据，但 asynchronous=false，不误套 *Async 的显式 Executor 要求。实际取消必须观察底层工作中断和 finally，而非只看 Future 状态。参考实现与八个可编译反例见 [导出取消记录](../eval/EXPORT-RESULTS.md)；这次没有调用模型，也不回填旧指标。

## 验证与证据边界

新增回归覆盖正常路径和对应反例，并有一条真实 Java 21 的“错误 API 编译失败 → 编译诊断进入修复提示 → 返回合法实现 → 编译与行为断言通过”链路。该测试使用确定性的模型回调，验证工程闭环，不代表模型生成成功率。

零调用审计位于 `.eval-cache/engine-review/pipeline-audit.json`：重新分析原始 63 份源码，核对 21 个规则提示词预算，重新编译原始四份 Rules 失败源码并保存修复反馈。旧报告和旧源码未覆盖。这是代码审查证据，不是新模型对比实验；静态诊断变化也不能当作模型能力提升。

仍有明确边界：单文件词法分析不等于 Java 编译器；不解析跨文件类型、复杂别名、继承和任意方法调用链；没有完整控制流/分支可达性证明。Future 委托、ThreadLocal 条件恢复、参数形式监控出口等采用有限的文件内模式，无法据此证明所有业务路径正确。大文件分析性能、更多 Java API 变体和完整任务清单仍需后续覆盖。下一轮模型实验必须使用新目录和新冻结记录，旧 17/21 不会因为这次审查自动变成新成功率。

本轮最终验证：`npm run typecheck`、`git diff --check` 通过；配置真实 Java 21 与固定依赖后，全量 116 项测试通过、0 失败、0 跳过（日志 `/tmp/engine-review-verified-tests.log`）。21 个规则提示词的完整知识上下文最高 1199 个估算 tokens，无超出 1200 的用例；原始四份编译失败代码仍由 javac 拒绝，诊断已进入修复反馈。原始生成报告和源码均保留。

实验执行器仍保留首次生成的三组比较语义，不会为了提高成功率自动调用 repair 或覆盖结果。核心库的修复闭环已经连通；未来评测闭环时须另记初次结果、最终结果、额外调用及成本。

另外以真实 Spring 6 / Java 21 运行了默认 Bean 销毁推断探针：不添加 PreDestroy，容器创建、执行任务和关闭回收均通过；证据保留在 `.eval-cache/engine-review/spring-inferred-destroy.json`。这验证了生命周期规则修正的运行依据。

## 后续真实验证

已完成新版本 63 次首次生成及独立修复，结果见 [v5 实验结果](../eval/V5-RESULTS.md)。实验进一步暴露出 private helper 写入与调用方 finally 的关联不足，现补上对应调用位置诊断、一层私有 helper 保护识别和导出调用线程上下文验收；保留安全/不安全调用的反例。该改动后的一次独立模型复验通过，不回填旧轮成功率。

收尾验证增加了 javac JVM 资源上限（与运行阶段同样的 128MB 堆、2 个逻辑处理器），处理并发回归中的编译资源波动；未延长检查超时。包含真实修复适配及 helper/调用线程回归后，全量 120 项测试通过、0 跳过。首次模型报告仍保持原始哈希，新的测试不能回填旧成功率。

中断恢复校验现支持 catch→finally 的有界同步路径识别，包含标志覆盖、条件分支、延迟 lambda、二次中断及 finally 覆盖异常的负例；实际 Java 中断标志验证与零调用历史复查见 [规则引擎现状](RULE-ENGINE-STATUS.md)。
