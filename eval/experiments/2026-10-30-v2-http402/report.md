# Phase 1 Evaluation Report

生成时间: 2026-10-30T02:34:40.511Z
规则总数: 26 | 用例数: 9 | 注入预算: 1200 tokens

## 1. 检索策略对比（Baseline vs RAG vs Rule Retrieval）

| Strategy | Rule P | Rule R | Rule F1 | Feature P | Feature R | Ref Recall (RAG) | Avg Context Tokens | Avg Budgeted Tokens | Avg Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | n/a | n/a | n/a | n/a | n/a | n/a | 0 | 0 | 0 |
| rag | n/a | n/a | n/a | n/a | n/a | 18.9% | 1164 | 1164 | 0 |
| rules | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | n/a | 2850 | 1167 | 16.3 |

> baseline / rag 不产出 Atomic Rule，因此规则与语义特征指标标记为 n/a；RAG 用 Ref Recall 衡量"检索到的文档片段是否覆盖期望规则引用的章节"。

## 2. validate 准确性（bad.java / good.java）

| Target | Cases | Violation P | Violation R | Errors | Warnings |
| --- | --- | --- | --- | --- | --- |
| bad.java (命中期望违规) | 9 | 100.0% | 100.0% | 33 | 20 |
| good.java (应为 0 个 error) | 9 | 100.0% | 100.0% | 0 | 0 |

## 3. Agent 在环指标

受控模型实验：未完成或未验证；model: deepseek-flash
- baseline/CASE-001: generation provenance does not match.
- baseline/CASE-002: missing or stale experiment inputs/call record.
- baseline/CASE-003: missing or stale experiment inputs/call record.
- baseline/CASE-006: missing or stale experiment inputs/call record.
- baseline/CASE-007: missing or stale experiment inputs/call record.
- baseline/CASE-008: missing or stale experiment inputs/call record.
- baseline/CASE-010: missing or stale experiment inputs/call record.
- baseline/CASE-011: missing or stale experiment inputs/call record.
- baseline/CASE-020: missing or stale experiment inputs/call record.
- rag/CASE-001: missing or stale experiment inputs/call record.
- rag/CASE-002: missing or stale experiment inputs/call record.
- rag/CASE-003: missing or stale experiment inputs/call record.
- rag/CASE-006: missing or stale experiment inputs/call record.
- rag/CASE-007: missing or stale experiment inputs/call record.
- rag/CASE-008: missing or stale experiment inputs/call record.
- rag/CASE-010: missing or stale experiment inputs/call record.
- rag/CASE-011: missing or stale experiment inputs/call record.
- rag/CASE-020: missing or stale experiment inputs/call record.
- rules/CASE-001: missing or stale experiment inputs/call record.
- rules/CASE-002: missing or stale experiment inputs/call record.
- rules/CASE-003: missing or stale experiment inputs/call record.
- rules/CASE-006: missing or stale experiment inputs/call record.
- rules/CASE-007: missing or stale experiment inputs/call record.
- rules/CASE-008: missing or stale experiment inputs/call record.
- rules/CASE-010: missing or stale experiment inputs/call record.
- rules/CASE-011: missing or stale experiment inputs/call record.
- rules/CASE-020: missing or stale experiment inputs/call record.

| Strategy | Planned | Missing / Invalid | Avg Rule Compliance (N) | Violation Instances / Rules | Compile | Functional Test | Task Completion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 9 | 9 / 0 | n/a (0) | 0 / 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 |
| rag | 9 | 9 / 0 | n/a (0) | 0 / 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 |
| rules | 9 | 9 / 0 | n/a (0) | 0 / 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 | 0/9 (0.0%); evaluated 0 |

| Strategy | Case | Output | Compile | Test | Task |
| --- | --- | --- | --- | --- | --- |
| baseline | CASE-001 | missing | not_run | not_run | not_run |
| baseline | CASE-002 | missing | not_run | not_run | not_run |
| baseline | CASE-003 | missing | not_run | not_run | not_run |
| baseline | CASE-006 | missing | not_run | not_run | not_run |
| baseline | CASE-007 | missing | not_run | not_run | not_run |
| baseline | CASE-008 | missing | not_run | not_run | not_run |
| baseline | CASE-010 | missing | not_run | not_run | not_run |
| baseline | CASE-011 | missing | not_run | not_run | not_run |
| baseline | CASE-020 | missing | not_run | not_run | not_run |
| rag | CASE-001 | missing | not_run | not_run | not_run |
| rag | CASE-002 | missing | not_run | not_run | not_run |
| rag | CASE-003 | missing | not_run | not_run | not_run |
| rag | CASE-006 | missing | not_run | not_run | not_run |
| rag | CASE-007 | missing | not_run | not_run | not_run |
| rag | CASE-008 | missing | not_run | not_run | not_run |
| rag | CASE-010 | missing | not_run | not_run | not_run |
| rag | CASE-011 | missing | not_run | not_run | not_run |
| rag | CASE-020 | missing | not_run | not_run | not_run |
| rules | CASE-001 | missing | not_run | not_run | not_run |
| rules | CASE-002 | missing | not_run | not_run | not_run |
| rules | CASE-003 | missing | not_run | not_run | not_run |
| rules | CASE-006 | missing | not_run | not_run | not_run |
| rules | CASE-007 | missing | not_run | not_run | not_run |
| rules | CASE-008 | missing | not_run | not_run | not_run |
| rules | CASE-010 | missing | not_run | not_run | not_run |
| rules | CASE-011 | missing | not_run | not_run | not_run |
| rules | CASE-020 | missing | not_run | not_run | not_run |

## 4. 说明

- results/<strategy>/<caseId>.java 为空：Rule Compliance / Compile Rate 需要 Agent 产出后重新运行。
- Java 编译使用真实 javac（默认 --release 21），缺失工具、超时、编译失败分别记录；不自动补桩或改写产出。
- 合规率按非 info 的已检查规则去重；无适用规则或语法无效时为 n/a。100% 离线召回衡量未裁剪规则集，不能代表预算裁剪后的覆盖率。
- Task not_run 包含尚未审查，以及已绑定源码完成审查但业务证据不足的情况；通过 task_check.detail 区分，均不算任务成功。
- Compile/Test/Task Rate 分母为每种策略全部计划用例；缺失、不可用、未执行单独记录并报告覆盖率，不能视为通过。21 个用例均有功能/运行行为断言，但尚未覆盖全部业务和异常分支。完整任务验收均需依据清单审查，不从合规率推断。

## 5. 检索明细（rules 策略）

| Case | Expected | Retrieved | P | R | Context Tokens |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | 12 | 12 | 100.0% | 100.0% | 2244 |
| CASE-002 | 14 | 14 | 100.0% | 100.0% | 2488 |
| CASE-003 | 16 | 16 | 100.0% | 100.0% | 2839 |
| CASE-006 | 17 | 17 | 100.0% | 100.0% | 2930 |
| CASE-007 | 17 | 17 | 100.0% | 100.0% | 2930 |
| CASE-008 | 13 | 13 | 100.0% | 100.0% | 2356 |
| CASE-010 | 17 | 17 | 100.0% | 100.0% | 2930 |
| CASE-011 | 20 | 20 | 100.0% | 100.0% | 3420 |
| CASE-020 | 21 | 21 | 100.0% | 100.0% | 3514 |

## 6. validate 明细

| Case | Target | Expected | Reported | P | R |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-001 TP-CONFIG-002 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CONFIG-001 TP-CONFIG-002 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-001 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-002 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-002 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-002 | 100.0% | 100.0% |
| CASE-002 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-003 | bad | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 | 100.0% | 100.0% |
| CASE-003 | good | - | - | 100.0% | 100.0% |
| CASE-006 | bad | TP-CONFIG-004 TP-CONFIG-006 TP-MONITOR-001 TP-SHUTDOWN-001 | TP-CONFIG-004 TP-CONFIG-006 TP-MONITOR-001 TP-SHUTDOWN-001 | 100.0% | 100.0% |
| CASE-006 | good | - | - | 100.0% | 100.0% |
| CASE-007 | bad | TP-MONITOR-001 TP-REJECT-002 TP-SHUTDOWN-001 | TP-MONITOR-001 TP-REJECT-002 TP-SHUTDOWN-001 | 100.0% | 100.0% |
| CASE-007 | good | - | - | 100.0% | 100.0% |
| CASE-008 | bad | TP-CREATE-003 TP-MONITOR-001 TP-REJECT-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-003 TP-MONITOR-001 TP-REJECT-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-008 | good | - | - | 100.0% | 100.0% |
| CASE-010 | bad | TP-CREATE-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-004 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-CREATE-004 | 100.0% | 100.0% |
| CASE-010 | good | - | - | 100.0% | 100.0% |
| CASE-011 | bad | TP-CREATE-002 TP-REJECT-003 TP-SHUTDOWN-002 | TP-CREATE-002 TP-REJECT-003 TP-SHUTDOWN-002 | 100.0% | 100.0% |
| CASE-011 | good | - | - | 100.0% | 100.0% |
| CASE-020 | bad | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-003 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-003 TP-SUBMIT-004 | 100.0% | 100.0% |
| CASE-020 | good | - | - | 100.0% | 100.0% |
