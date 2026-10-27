# Agent 对比实验（2026-10-27）

请求模型别名 deepseek-chat；36 次响应均返回 deepseek-flash。三组使用相同任务与生成参数，temperature=0，4 个任务各执行 3 轮，无修复反馈。使用 OpenJDK 21.0.12.1 编译，执行固定行为测试。

| 策略 | 次数 | 规范遵循率 | 违规次数 | 编译率 | 任务完成率 | 实际总 token |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 12 | 83.3% | 24 | 100% | 100% | 4,484 |
| rag | 12 | 87.5% | 12 | 100% | 100% | 16,799 |
| rules | 12 | 86.1% | 13 | 100% | 100% | 13,237 |

规则组 token 比 RAG 少约 21.2%，合规率略低于 RAG。当前样本没有证明规则组能提高功能完成率。规范遵循率由静态检查器计算，包含 info 级提示；36 次请求均有 provider usage。单次小样本实验不代表真实业务泛化效果。

独立边界集共 10 个定向案例：precision=80%、recall=80%、误报率=20%。保留跨文件清理的一个误报和跨文件队列工厂的一个漏报。Apache Commons Lang BasicThreadFactory 真实代码兼容性样本无解析错误，许可、来源及 SHA-256 见 eval/fixtures/real-world/README.md。四个行为任务是自行编写的生产场景模拟，开源源码另作静态兼容性检查。

类型检查、全部 6 个测试文件和原有 21 个静态用例评测通过。行为契约覆盖异步通知失败隔离及关闭等待、超时取消与中断、上下文恢复、优雅关闭。

同目录包含冻结的 manifest、summary.json、results.json 及边界报告。36 个生成的 Java 文件同时保存在本目录 generated/ 下；逐次 prompt、原始响应内容和诊断保存在 .eval-cache/agent-final，完整归档为 .eval-cache/agent-final-records.zip。运行方法与指标定义见 eval/AGENT-EXPERIMENT.md。

```bash
npm run setup:java
npm run eval:agent -- eval/agent.config.example.json
npm run eval:boundaries
```

环境需注入 EVAL_API_BASE、EVAL_API_KEY。相同配置重跑会复用缓存；新实验使用新的 outputDir。temperature=0 的重复执行不代表独立随机样本，provider 别名可能变化。后续应扩大真实业务任务并人工复核违规，再评估 Cline 集成。

历史引擎版本：5edb375。合并远端 work 后引擎与规则已更新，此处报告是合并前快照；重新比较需使用新 outputDir。
