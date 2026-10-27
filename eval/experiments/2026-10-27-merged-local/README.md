# 合并后验收与本地复验（2026-10-27）

引擎与规则基于 work 分支合并结果，环境配置提交为 48f9b8d。Spring / Micrometer Core / HdrHistogram / LatencyUtils / Jakarta / SLF4J 等 14 个固定依赖均验证 SHA-256。完整测试结果：139 项通过、0 失败、0 跳过，详见 full-validation.log.txt。

## 已执行

- 139 项完整回归，包含此前因 classpath 缺失而跳过的六项行为验收。
- 36 份历史生成代码的本地重新编译、行为断言及当前引擎规则检查，见 report.md / report.json。模型新增调用为 0，原始源码与历史结果未修改。这是旧产出的重查，不是新提示词策略对比。
- 独立边界评测与当前 21 例静态评测，见 boundaries.json / offline.json。跨文件清理误报、队列工厂漏报仍保留。

## 尚未执行

新一轮 21 用例 × 3 策略的 63 次 DeepSeek 调用已完成提示词准备，见 prepared-prompts/ 与 prepared-experiment.json。自动审批拒绝发送，理由是需要明确授权将本轮代码与提示词发送至 api.deepseek.com。未发出本轮请求；不将准备记录当作新生成结果。没有开展基于新生成结果的业务审查或 Cline 集成。

## 后续运行

```bash
npm run setup:eval
npm run check:eval
npm run test:eval
```

环境选择脚本在脚本启动时校验所有固定依赖，正式回归不再依赖手工设置 EVAL_JAVAC / EVAL_JAVA / EVAL_CLASSPATH。

批准新调用后，应使用新目录运行正式 experiment（prepare-only 目录不直接 resume）；先保存首次生成结果，再做逐例业务审查。没有证据前不宣称 Rules 优于 baseline / RAG，不进入自动修复默认启用阶段。
