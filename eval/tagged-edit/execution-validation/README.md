# 执行器验证

本目录记录执行器本地测试及参考代码适配器演练，不是真实供应商生成对比。targeted-initial.log.txt 为首次 16 项定向通过记录。dry-runs/2026-11-02-recorder 为 9 槽位参考代码演练，model_requests=0，request_attempts=9，controlled_model_comparison=false，usage 未知。默认适配器测试使用 mock fetch，不产生真实 HTTP 请求。

公开 API 结构校验不代替完整源码兼容审查。参考 EventPublisher 的 stop 已保留无 checked throws 的原公开约定；参考实现及其通过不计入任何策略模型成绩。最终完整回归结果见本目录 final-full.log.txt 和 summary.json。
