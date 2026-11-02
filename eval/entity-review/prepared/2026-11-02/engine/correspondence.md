# 实体—知识—候选修改任务对应表（引擎预测，非标准答案）

| 任务 | 修改实体 | 预算内预测叶子 | 独立标注 |
| --- | --- | --- | --- |
| REVIEW-CAPACITY | eval/entity-review/cases/ExportWorker.java#ExportWorker::export(String) | tp.use.result, tp.use.exception, tp.create.workload, tp.create.explicit, tp.create.sizing, tp.create.queue | 待填写 |
| REVIEW-TENANT | eval/entity-review/cases/TenantBatchService.java#TenantBatchService::process(String,String) | tp.use.context, tp.use.result, tp.create.workload, tp.create.explicit, tp.create.sizing, tp.create.queue | 待填写 |
| REVIEW-FAILURE | eval/entity-review/cases/ExceptionWorker.java#ExceptionWorker::deliver(String) | tp.use.result, tp.use.exception, tp.create.workload, tp.create.explicit, tp.create.sizing, tp.create.queue, tp.create.naming | 待填写 |

公共评审包不包含本表；不能用这些预测回填标准答案。
