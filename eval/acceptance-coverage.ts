/** Audited test scope, not a task-success verdict. Keep gaps explicit even when runtime checks pass. */
export interface AcceptanceCoverage {
  normal: string;
  failure: string;
  lifecycle: string;
  gaps: string;
  priority: 'P1' | 'P2';
}
export const ACCEPTANCE_COVERAGE: Record<string, AcceptanceCoverage> = {
  'CASE-001': {normal:'部分：池任务计数增加',failure:'未测下游失败',lifecycle:'仅 harness 清理',gaps:'捕获真实通知回调；注入失败，验证不影响主流程；验证过载时仍异步。',priority:'P1'},
  'CASE-002': {normal:'部分：任务提交与 worker 上下文为空',failure:'未注入业务异常',lifecycle:'仅 harness 清理',gaps:'真实同步回调、已有 caller/worker 上下文保留、异常及取消清理。',priority:'P1'},
  'CASE-003': {normal:'仅测试池自身能执行探针',failure:'只检查队列容量',lifecycle:'仅 harness 清理',gaps:'调用实际导出入口；饱和拒绝、补偿及导出结果。',priority:'P1'},
  'CASE-004': {normal:'注入订单重试回调，多轮原始订单与固定延迟',failure:'首轮异常后再成功三轮，第二订单隔离；配置校验与拒绝补偿',lifecycle:'取消未开始延迟任务、重复关闭、强制中断与调用方中断',gaps:'真实支付接口、退避/重试次数、幂等与去重、注册容量上限、持久化及不可中断下游未验证。',priority:'P2'},
  'CASE-005': {normal:'只读 core/max 配置',failure:'未测真实满载与拒绝',lifecycle:'只读 keepAlive 配置',gaps:'阻塞 worker 填满队列后实际扩容，释放后观察非核心线程回收。',priority:'P2'},
  'CASE-006': {normal:'显式优先级、同级 FIFO、旧接口默认值',failure:'混合优先级/同级满载、并发替换、回调失败',lifecycle:'生产参数准入、关闭后拒绝',gaps:'未穷举提交/关闭竞态；真实业务由 Consumer 注入，不含下游系统。',priority:'P2'},
  'CASE-007': {normal:'未验证实际日志写入',failure:'关闭后拒绝计数',lifecycle:'直接关闭池触发拒绝',gaps:'注入真实写入回调与失败；满载丢弃策略及告警内容；重复统计不误增。',priority:'P1'},
  'CASE-008': {normal:'未验证真实库存同步',failure:'关闭后拒绝 SKU 进入 retryQueue',lifecycle:'直接关闭池触发拒绝',gaps:'实际同步回调与失败；补偿恢复执行、重复补偿边界。',priority:'P1'},
  'CASE-009': {normal:'未验证通知内容与结果',failure:'拒绝计数增长，未断言日志',lifecycle:'直接关闭池触发拒绝',gaps:'饱和场景、自定义策略日志/持久记录、下游发送异常。',priority:'P1'},
  'CASE-010': {normal:'池探针线程名含 file；调用 process',failure:'未测文件处理异常',lifecycle:'仅 harness 清理',gaps:'捕获真实文件处理回调所在的线程、处理结果和失败补偿。',priority:'P1'},
  'CASE-011': {normal:'两次事件增加同一池任务计数',failure:'未注入推送异常',lifecycle:'两次调用后池未关闭',gaps:'真实事件推送结果、连续调用异常隔离、池生命周期。',priority:'P1'},
  'CASE-012': {normal:'多个报价结果及异步返回',failure:'占满业务 worker 后有界超时',lifecycle:'仅 harness 清理',gaps:'注入实际下游回调、异常；超时是否需要停止底层工作仍须明确契约。',priority:'P1'},
  'CASE-013': {normal:'已接受的运行任务完成',failure:'未测超时/中断回退',lifecycle:'stop 等待运行任务',gaps:'增加排队业务任务；重复关闭；超时与中断下补偿。',priority:'P2'},
  'CASE-014': {normal:'未验证风险业务执行',failure:'调用线程中断标志保留',lifecycle:'中断 stop 后池 shutdown',gaps:'验证实际终止、未执行任务去向和正常关闭路径。',priority:'P2'},
  'CASE-015': {normal:'未验证审计业务结果',failure:'中断关闭时待执行 Runnable 转入 fallbackQueue',lifecycle:'只覆盖中断路径',gaps:'正常超时强制关闭、真实补偿执行、重复关闭不重复补偿。',priority:'P2'},
  'CASE-016': {normal:'真实 Spring 容器创建 Bean 并执行池探针',failure:'未测 Bean 创建失败/任务异常',lifecycle:'容器销毁池；stats 可读',gaps:'运行指标数值真实性与变化；业务通知回调；异常关闭分支。',priority:'P2'},
  'CASE-017': {normal:'真实注入回调在虚拟线程，限额 2',failure:'24 个并发拒绝、异常与中断后恢复、计数',lifecycle:'停止准入、等待完成及重复 stop',gaps:'不含真实 HTTP 或全局连接池；不响应中断与全部竞态未穷举。',priority:'P2'},
  'CASE-018': {normal:'存在两个独立池，调用结算入口',failure:'未注入结算/重试异常',lifecycle:'两个池均 shutdown，未断言双池监控',gaps:'捕获真实结算和重试路径；逐池指标、异常隔离和关闭等待。',priority:'P1'},
  'CASE-019': {normal:'金额求和、VIP 折扣及空列表',failure:'未定义非法输入契约',lifecycle:'不应引入线程池，由静态检查辅助',gaps:'按业务需要明确精度、负数、null 和大数输入；无并发需求。',priority:'P2'},
  'CASE-020': {normal:'实际注入导出结果，空/已有上下文',failure:'超时/中断停止可中断工作、异常因果、拒绝、排队回收',lifecycle:'强制关闭完成排队结果，重复关闭等待；不可中断任务有界报告失败',gaps:'CompletableFuture 数据流仍须源码审查；真实下游响应中断与容器集成未完整验证。',priority:'P2'},
  'CASE-021': {normal:'真实 Spring 裸池 Bean 执行探针',failure:'未验证通知异常与后续通知',lifecycle:'容器关闭回收裸池',gaps:'通过业务入口注入通知异常，再验证后续任务仍处理；拒绝与补偿。',priority:'P1'},
};
