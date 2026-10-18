# Phase 1 Evaluation Report

生成时间: 2026-09-21T16:09:48.587Z
规则总数: 26 | 用例数: 21 | 注入预算: 1200 tokens

## 1. 检索策略对比（Baseline vs RAG vs Rule Retrieval）

| Strategy | Rule P | Rule R | Rule F1 | Feature P | Feature R | Ref Recall (RAG) | Avg Context Tokens | Avg Budgeted Tokens | Avg Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | n/a | n/a | n/a | n/a | n/a | n/a | 0 | 0 | 0 |
| rag | n/a | n/a | n/a | n/a | n/a | 20.5% | 1186 | 1186 | 0 |
| rules | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | n/a | 1211 | 1011 | 14.8 |

> baseline / rag 不产出 Atomic Rule，因此规则与语义特征指标标记为 n/a；RAG 用 Ref Recall 衡量"检索到的文档片段是否覆盖期望规则引用的章节"。

## 2. validate 准确性（bad.java / good.java）

| Target | Cases | Violation P | Violation R | Errors | Warnings |
| --- | --- | --- | --- | --- | --- |
| bad.java (命中期望违规) | 21 | 100.0% | 100.0% | 48 | 35 |
| good.java (应为 0 个 error) | 19 | 100.0% | 100.0% | 0 | 0 |

## 3. Agent 在环指标

暂无 Agent 产出，Rule Compliance Rate / Compile Rate 待回填。

操作方式：把 `prompts/<strategy>/<caseId>.md` 交给 Cline 执行，把产出的 Java 代码放到
`results/<strategy>/<caseId>.java`，再运行 `npm run engine -- eval --agent-results`。

## 4. 说明

- 未启用 Agent 在环评测（--agent-results）：Rule Compliance / Compile Rate 需要 Agent 产出。
- Compile Rate 需要 JDK（javac）：未检测到 javac 时统一标记为 unavailable，可在接入 JDK 后补充编译校验。

## 5. 检索明细（rules 策略）

| Case | Expected | Retrieved | P | R | Context Tokens |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | 12 | 12 | 100.0% | 100.0% | 1007 |
| CASE-002 | 14 | 14 | 100.0% | 100.0% | 1137 |
| CASE-003 | 16 | 16 | 100.0% | 100.0% | 1334 |
| CASE-004 | 11 | 11 | 100.0% | 100.0% | 923 |
| CASE-005 | 17 | 17 | 100.0% | 100.0% | 1395 |
| CASE-006 | 17 | 17 | 100.0% | 100.0% | 1395 |
| CASE-007 | 17 | 17 | 100.0% | 100.0% | 1395 |
| CASE-008 | 13 | 13 | 100.0% | 100.0% | 1089 |
| CASE-009 | 15 | 15 | 100.0% | 100.0% | 1236 |
| CASE-010 | 17 | 17 | 100.0% | 100.0% | 1395 |
| CASE-011 | 20 | 20 | 100.0% | 100.0% | 1655 |
| CASE-012 | 1 | 1 | 100.0% | 100.0% | 56 |
| CASE-013 | 20 | 20 | 100.0% | 100.0% | 1635 |
| CASE-014 | 21 | 21 | 100.0% | 100.0% | 1707 |
| CASE-015 | 18 | 18 | 100.0% | 100.0% | 1456 |
| CASE-016 | 14 | 14 | 100.0% | 100.0% | 1128 |
| CASE-017 | 8 | 8 | 100.0% | 100.0% | 674 |
| CASE-018 | 21 | 21 | 100.0% | 100.0% | 1707 |
| CASE-019 | 0 | 0 | 100.0% | 100.0% | 0 |
| CASE-020 | 21 | 21 | 100.0% | 100.0% | 1648 |
| CASE-021 | 18 | 18 | 100.0% | 100.0% | 1461 |

## 6. validate 明细

| Case | Target | Expected | Reported | P | R |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-001 TP-CONFIG-002 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CONFIG-001 TP-CONFIG-002 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-001 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-002 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-002 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-002 | 100.0% | 100.0% |
| CASE-002 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-003 | bad | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 | 100.0% | 100.0% |
| CASE-003 | good | - | - | 100.0% | 100.0% |
| CASE-004 | bad | TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-004 | good | - | - | 100.0% | 100.0% |
| CASE-005 | bad | TP-CONFIG-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CONFIG-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-005 | good | - | - | 100.0% | 100.0% |
| CASE-006 | bad | TP-CONFIG-004 TP-CONFIG-006 TP-MONITOR-001 TP-SHUTDOWN-001 | TP-CONFIG-004 TP-CONFIG-006 TP-MONITOR-001 TP-SHUTDOWN-001 | 100.0% | 100.0% |
| CASE-006 | good | - | - | 100.0% | 100.0% |
| CASE-007 | bad | TP-MONITOR-001 TP-REJECT-002 TP-SHUTDOWN-001 | TP-MONITOR-001 TP-REJECT-002 TP-SHUTDOWN-001 | 100.0% | 100.0% |
| CASE-007 | good | - | - | 100.0% | 100.0% |
| CASE-008 | bad | TP-CREATE-003 TP-MONITOR-001 TP-REJECT-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-003 TP-MONITOR-001 TP-REJECT-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-008 | good | - | - | 100.0% | 100.0% |
| CASE-009 | bad | TP-MONITOR-001 TP-REJECT-005 TP-SHUTDOWN-001 | TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-005 | 100.0% | 100.0% |
| CASE-009 | good | - | - | 100.0% | 100.0% |
| CASE-010 | bad | TP-CREATE-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-CREATE-004 | 100.0% | 100.0% |
| CASE-010 | good | - | - | 100.0% | 100.0% |
| CASE-011 | bad | TP-CREATE-002 TP-REJECT-003 TP-SHUTDOWN-002 | TP-CREATE-002 TP-REJECT-003 TP-SHUTDOWN-002 | 100.0% | 100.0% |
| CASE-011 | good | - | - | 100.0% | 100.0% |
| CASE-012 | bad | TP-SUBMIT-002 TP-SUBMIT-003 | TP-SUBMIT-003 TP-SUBMIT-003 TP-SUBMIT-002 | 100.0% | 100.0% |
| CASE-012 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-013 | bad | TP-MONITOR-001 TP-SHUTDOWN-002 | TP-MONITOR-001 TP-SHUTDOWN-002 | 100.0% | 100.0% |
| CASE-013 | good | - | - | 100.0% | 100.0% |
| CASE-014 | bad | TP-SHUTDOWN-003 | TP-SHUTDOWN-003 | 100.0% | 100.0% |
| CASE-014 | good | - | - | 100.0% | 100.0% |
| CASE-015 | bad | TP-REJECT-004 TP-SHUTDOWN-004 | TP-REJECT-004 TP-SHUTDOWN-004 TP-SHUTDOWN-004 | 100.0% | 100.0% |
| CASE-015 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-016 | bad | TP-MONITOR-001 | TP-MONITOR-001 | 100.0% | 100.0% |
| CASE-016 | good | - | - | 100.0% | 100.0% |
| CASE-017 | bad | TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-017 | good | - | - | 100.0% | 100.0% |
| CASE-018 | bad | TP-CREATE-001 TP-CREATE-003 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-001 TP-CREATE-003 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-018 | good | - | - | 100.0% | 100.0% |
| CASE-019 | bad | - | - | 100.0% | 100.0% |
| CASE-020 | bad | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-003 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-003 | 100.0% | 100.0% |
| CASE-021 | bad | TP-CREATE-005 TP-MONITOR-001 TP-REJECT-003 TP-SUBMIT-005 | TP-CREATE-005 TP-MONITOR-001 TP-REJECT-003 TP-SUBMIT-005 | 100.0% | 100.0% |
| CASE-021 | good | - | - | 100.0% | 100.0% |
