# 规则覆盖补充复盘证据

本目录与历史实验分开；模型请求为 0。范围为 `eval/experiments/2026-10-27-63calls` 的 63 份源码，以及 `eval/experiments/2026-11-02-observable-v2` 的 27 份源码。原始响应、生成源码、编译 / 业务报告和 usage 均不修改。

## 文件

- before.json：53a46ea 之后、checker 修改前的静态复查，含源码哈希、完整诊断、1200 估算 token 预算下的规则召回与省略记录。
- after.json：首版实现快照；保留用于说明实现过程，最终结果使用 after-final.json。
- after-final.json：修正 caller 恢复关联、排除 AbortPolicy 拒绝后取消等边界后的最终静态复查。
- after-verified.json：与 after-final.json 的 90 条记录完全一致，另保存全部 src / knowledge 文件的 SHA-256，包含新增的未提交实现文件，作为最终可复核实现指纹。
- delta.json：90 个源码哈希全部一致；6 份 CASE-020 各增加 2 条取消队列风险 warning，共 12 条，其他规则诊断位置集合不变。新增诊断不等于新增已确认的真实业务缺陷。
- priority-evidence.json：8 个强制关闭丢任务样本已有 TP-SHUTDOWN-004 warning，4 个已确认调用者上下文泄漏样本已有 TP-SUBMIT-004 error 的证据。
- fixtures/、fixture-comparison.json：在隔离的 53a46ea 源码副本与当前实现上，对同一批命名反例 / 正例做对比。9 个定向例子中确认 5 个原漏报、1 个原误报，3 个原正例保持不报；不是准确率基准，不推广为独立精确率 / 召回率。
- validation/：验证日志和汇总（中间失败原始日志以 gzip 无损保存，最终通过日志为纯文本），包含开发中发现的失败及修正后的最终结果，不能将旧失败日志误认为最终通过记录。

复盘结论见 `docs/RULE-COVERAGE-REVIEW.md`；全部规则能力边界见 `docs/CAPABILITIES.md`。未接入 Cline，不启用自动修改。

## 复查命令

```bash
# 输出必须是新路径，脚本拒绝覆盖现有审计。
node eval/audit-rule-coverage.ts .eval-cache/review-recheck.json
npm run check:eval
npm run typecheck
npm run test:eval
```

JVM 新增场景见 tests/rule-coverage.test.ts：直接恢复旧值、未执行的延迟清理、条件不执行的清理，按真实线程上下文对照诊断；不安全场景中探针通过仅表示成功复现泄漏。原有取消、包装器错误和强制关闭行为证据仍引用历史实验及现有测试，不付费重新生成。

原始完整任务完成率、规范遵循率、策略排名和 tokens 没有被本次复查重算。warning 的新增及误报修复反映 checker 覆盖变化，不证明生成策略质量提高。

最终验证：类型检查通过，JDK 21 与固定依赖校验通过；定向 20/20、完整回归 158/158，均 0 失败、0 跳过。开发过程的失败日志单独保留，最终日志见 validation/final-full.log.txt。
