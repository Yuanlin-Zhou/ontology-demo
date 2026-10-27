# 21 用例参考实现验收矩阵

本地审计日期：2026-10-21。这是参考集与验收覆盖盘点，不是模型三组比较。

编译通过 21/21；当前运行探针通过 21/21；含空方法的参考源码 14 份。

这里的通过仅指当前探针，不是完整任务通过；工具不执行任务审查，task_status 保持 not_reviewed，不覆盖另存的源码绑定审查。CASE-019 使用 before.java 负对照。每例 JSON 和 sources/ 副本绑定实际源码与验收器哈希，空方法只是审查线索。

| 用例 | 编译 | 静态 error | 运行探针 | 空方法 | 正常路径覆盖 | 异常路径覆盖 | 关闭覆盖 | 仍需补齐 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| CASE-001 | ok | 0 | ok | sendRemote | 部分：池任务计数增加 | 未测下游失败 | 仅 harness 清理 | P1：捕获真实通知回调；注入失败，验证不影响主流程；验证过载时仍异步。 |
| CASE-002 | ok | 0 | ok | syncRemote | 部分：任务提交与 worker 上下文为空 | 未注入业务异常 | 仅 harness 清理 | P1：真实同步回调、已有 caller/worker 上下文保留、异常及取消清理。 |
| CASE-003 | ok | 0 | ok | doExport | 仅测试池自身能执行探针 | 只检查队列容量 | 仅 harness 清理 | P1：调用实际导出入口；饱和拒绝、补偿及导出结果。 |
| CASE-004 | ok | 0 | ok | 无 | 实际注入订单回调、多轮原始订单及固定延迟 | 首轮失败后成功三轮、订单隔离、配置校验及拒绝补偿 | 未开始任务取消、重复关闭、强制/调用方中断 | P2：真实支付、退避/次数、幂等去重、注册容量与持久化；见 RETRY-RESULTS.md。 |
| CASE-005 | ok | 0 | ok | execute | 只读 core/max 配置 | 未测真实满载与拒绝 | 只读 keepAlive 配置 | P2：阻塞 worker 填满队列后实际扩容，释放后观察非核心线程回收。 |
| CASE-006 | ok | 0 | ok | 无 | 显式优先级、同级 FIFO、旧接口默认值 | 混合优先级/同级满载、并发替换、回调失败 | 生产参数准入、关闭后拒绝 | P2：未穷举提交/关闭竞态；真实业务由 Consumer 注入，不含下游系统。 |
| CASE-007 | ok | 0 | ok | append | 未验证实际日志写入 | 关闭后拒绝计数 | 直接关闭池触发拒绝 | P1：注入真实写入回调与失败；满载丢弃策略及告警内容；重复统计不误增。 |
| CASE-008 | ok | 0 | ok | remoteSync | 未验证真实库存同步 | 关闭后拒绝 SKU 进入 retryQueue | 直接关闭池触发拒绝 | P1：实际同步回调与失败；补偿恢复执行、重复补偿边界。 |
| CASE-009 | ok | 0 | ok | send | 未验证通知内容与结果 | 拒绝计数增长，未断言日志 | 直接关闭池触发拒绝 | P1：饱和场景、自定义策略日志/持久记录、下游发送异常。 |
| CASE-010 | ok | 0 | ok | handle | 池探针线程名含 file；调用 process | 未测文件处理异常 | 仅 harness 清理 | P1：捕获真实文件处理回调所在的线程、处理结果和失败补偿。 |
| CASE-011 | ok | 0 | ok | push | 两次事件增加同一池任务计数 | 未注入推送异常 | 两次调用后池未关闭 | P1：真实事件推送结果、连续调用异常隔离、池生命周期。 |
| CASE-012 | ok | 0 | ok | 无 | 多个报价结果及异步返回 | 占满业务 worker 后有界超时 | 仅 harness 清理 | P1：注入实际下游回调、异常；超时是否需要停止底层工作仍须明确契约。 |
| CASE-013 | ok | 0 | ok | doAccrue | 已接受的运行任务完成 | 未测超时/中断回退 | stop 等待运行任务 | P2：增加排队业务任务；重复关闭；超时与中断下补偿。 |
| CASE-014 | ok | 0 | ok | remoteEvaluate | 未验证风险业务执行 | 调用线程中断标志保留 | 中断 stop 后池 shutdown | P2：验证实际终止、未执行任务去向和正常关闭路径。 |
| CASE-015 | ok | 0 | ok | 无 | 未验证审计业务结果 | 中断关闭时待执行 Runnable 转入 fallbackQueue | 只覆盖中断路径 | P2：正常超时强制关闭、真实补偿执行、重复关闭不重复补偿。 |
| CASE-016 | ok | 0 | ok | 无 | 真实 Spring 容器创建 Bean 并执行池探针 | 未测 Bean 创建失败/任务异常 | 容器销毁池；stats 可读 | P2：运行指标数值真实性与变化；业务通知回调；异常关闭分支。 |
| CASE-017 | ok | 0 | ok | 无 | 真实注入回调在虚拟线程，限额 2 | 24 个并发拒绝、异常与中断后恢复、计数 | 停止准入、等待完成及重复 stop | P2：不含真实 HTTP 或全局连接池；不响应中断与全部竞态未穷举。 |
| CASE-018 | ok | 0 | ok | doSettle | 存在两个独立池，调用结算入口 | 未注入结算/重试异常 | 两个池均 shutdown，未断言双池监控 | P1：捕获真实结算和重试路径；逐池指标、异常隔离和关闭等待。 |
| CASE-019 | ok | 0 | ok | 无 | 金额求和、VIP 折扣及空列表 | 未定义非法输入契约 | 不应引入线程池，由静态检查辅助 | P2：按业务需要明确精度、负数、null 和大数输入；无并发需求。 |
| CASE-020 | ok | 0 | ok | 无 | 实际注入导出结果，空/已有上下文 | 超时/中断停止可中断工作、异常因果、拒绝、排队回收 | 强制关闭完成排队结果，重复关闭等待；不可中断任务有界报告失败 | P2：CompletableFuture 数据流仍须源码审查；真实下游响应中断与容器集成未完整验证。 |
| CASE-021 | ok | 0 | ok | send | 真实 Spring 裸池 Bean 执行探针 | 未验证通知异常与后续通知 | 容器关闭回收裸池 | P1：通过业务入口注入通知异常，再验证后续任务仍处理；拒绝与补偿。 |

## 每项原始验收标准

- CASE-001：订单通知确实在异步执行路径发生；下游通知失败不影响下单主流程。源码：../cases/CASE-001-executors-fixed-pool/good.java
- CASE-002：订单同步任务实际执行且异常可见；复用工作线程时租户上下文不串数据。源码：../cases/CASE-002-threadlocal-and-future/good.java
- CASE-003：导出请求能够被执行；过载时队列内存有界且拒绝行为明确。源码：../cases/CASE-003-unbounded-queue/good.java
- CASE-004：失败订单会被周期性重试；一次重试异常不会永久中止后续调度。源码：../cases/CASE-004-scheduled-retry/good.java
- CASE-005：高峰时线程数能扩容；空闲后非核心线程可以回收。源码：../cases/CASE-005-keepalive-zero/good.java
- CASE-006：高优先级任务先于低优先级任务执行；过载淘汰最旧任务且不误删最高优先级任务。源码：../cases/CASE-006-priority-queue-discard-oldest/good.java
- CASE-007：日志异步写入；过载丢弃有计数并有可观测告警。源码：../cases/CASE-007-discard-policy/good.java
- CASE-008：库存同步实际执行；拒绝时调用侧执行可验证的补偿。源码：../cases/CASE-008-default-rejection/good.java
- CASE-009：自定义拒绝路径留有日志或持久记录；拒绝次数可被监控统计。源码：../cases/CASE-009-custom-rejection-handler/good.java
- CASE-010：文件处理实际执行；实际工作线程名可识别文件处理业务。源码：../cases/CASE-010-unnamed-thread-factory/good.java
- CASE-011：连续事件都能被推送；多次调用复用同一个业务线程池。源码：../cases/CASE-011-per-request-pool/good.java
- CASE-012：异步返回正确报价；阻塞下游在业务线程池运行且等待有超时。源码：../cases/CASE-012-async-common-pool/good.java
- CASE-013：关闭时已接受的队列任务被处理；关闭方法等待任务完成后返回。源码：../cases/CASE-013-shutdown-without-await/good.java
- CASE-014：关闭流程响应中断；捕获中断后恢复中断标志。源码：../cases/CASE-014-interrupt-swallowed/good.java
- CASE-015：强制关闭时未执行任务被记录或补偿；正常关闭与中断路径都不静默丢弃待执行任务。源码：../cases/CASE-015-shutdownnow-pending/good.java
- CASE-016：真实 Spring 容器可创建和销毁线程池 Bean；线程池有可读取的监控出口。源码：../cases/CASE-016-spring-bean-executor/good.java
- CASE-017：阻塞通知在虚拟线程执行；并发访问下游有实际限流上限。源码：../cases/CASE-017-virtual-thread/good.java
- CASE-018：结算执行与重试调度使用独立线程池；两个线程池都有监控和关闭流程。源码：../cases/CASE-018-two-pools/good.java
- CASE-019：金额求和与 VIP 折扣保持正确；纯金额业务不引入线程池。源码：../cases/CASE-019-negative-control/before.java
- CASE-020：CompletableFuture 编排返回正确导出结果；线程上下文在正常和异常路径都得到清理；超时取消及关闭路径有效。源码：../cases/CASE-020-mixed-export/good.java
- CASE-021：真实 Spring 容器关闭时回收裸线程池；通知任务异常可见且不杀死后续任务处理。源码：../cases/CASE-021-spring-raw-bean-executor/good.java

## 本次修复与证据

初次审计中，20 份 good.java 仅 4 份能独立编译，16 份缺少 logger 或补偿队列声明；CASE-019 按设计没有 good.java，最终审计显式采用未修改的 before.java 负对照。补齐 16 份参考源码的真实 SLF4J logger，以及已有代码引用的 Queue<String>/Queue<Runnable> 声明；没有为业务方法补假实现，也没有修改任何历史模型候选。

初次诊断及修改前源码保留在 `.eval-cache/phase1-reference-audit-initial-v2/`，声明修改明细在 member-fixes.json。最终逐例编译、运行、静态检查与当前源码/验收器哈希保留在 `.eval-cache/phase1-reference-audit-completed/`。21 个参考输入编译及当前运行探针均通过，静态 error 为 0；14 份仍含空方法。这既不表示所有空方法都是同一种业务错误，也不表示业务任务已通过。

补偿队列声明仅补全原有 offer 调用所需的内存示例，不提供持久化、容量控制或自动恢复执行保证；这些语义仍须在对应任务中明确并验收。

已有的 CASE-006 优先级、CASE-017 限流及 CASE-020 取消的独立证据分别见 [优先级记录](PRIORITY-RESULTS.md)、[限流记录](VIRTUAL-RESULTS.md)、[导出记录](EXPORT-RESULTS.md)。这些记录区分模型候选和手写参考；例如 CASE-020 的参考源码有绑定哈希的 Agent 审查，但不能据此批准将来生成的另一份代码。

## 优先补齐顺序

1. CASE-001/002/021：注入实际通知/同步回调，验证正常参数、工作线程、异常隔离；覆盖过载策略对主流程的影响。
2. CASE-004 的回调、异常后继续与关闭验收已完成；定向模型产出通过，详见 [重试记录](RETRY-RESULTS.md)。其真实支付、容量和持久化仍为后续事项。
3. CASE-007/008/009/010/011：分别观察真实日志写入、库存同步、通知、文件处理和推送回调，验证失败及补偿，而非只看池任务计数。
4. CASE-012/018：注入下游结果/异常，验证实际执行路径、双池隔离及每个资源的指标。
5. CASE-005/013/014/015/016：扩容与回收实测，排队任务关闭、超时和中断分支，监控数值变化及容器异常分支。

这里要求可观察的注入回调与明确业务约定，不要求构建真实订单、库存或 HTTP 系统。每轮只补对应任务的必要接口；同一冻结契约必须对 Baseline/RAG/Rules 一致。先补 P1 缺口并逐项记录证据，再冻结代码、任务及验证器做新一轮三组比较。

## 重复执行

```bash
node eval/audit-references.ts NEW_OUT_DIR JAVA_CONFIG_JSON
```

配置可使用包含 java 配置的实验 JSON，也可使用直接的 JavaOptions JSON；省略配置时读取 EVAL_JAVAC/EVAL_JAVA/EVAL_CLASSPATH。输出目录必须不存在，避免覆盖证据。源码发生变化后，需要新审计和新的源码哈希绑定审查。

## CASE-020 模型复验状态

2026-10-26 已从上一轮最终模型候选继续修复，并加入源码审查反馈：新增 3 次 DeepSeek 调用，共 17,747 tokens。最新候选编译及运行验收通过，CompletableFuture 结果/取消链路另作源码哈希绑定审查，随后零模型调用复验。保留失败、stalled、unverified 各轮原始证据，不回填首次比较；最终详情见 [导出复验记录](EXPORT-RESULTS.md)。参考矩阵的 21/21 仍不代表所有模型生成通过。

## 收尾验证

完整本地回归 **128/128 通过、0 跳过**，日志 `/tmp/phase1-matrix-verified-tests.log`；TypeScript 类型检查、git diff --check 通过。16 份声明修复均通过公开 API 结构保留检查；逐例当前源码及验收器哈希与审计记录一致。已有 CASE-017/020 的参考源码绑定审查仍有效，没有被自动工具的 not_reviewed 状态覆盖。汇总保留在 `.eval-cache/phase1-matrix-final-summary.json`。

CASE-004 行已按新增独立验收更新；早期 21 例审计缓存仍保留原源码和旧验收哈希，不回写为新验收结果。当前模型定向修复详情及成本见 [重试记录](RETRY-RESULTS.md)。
