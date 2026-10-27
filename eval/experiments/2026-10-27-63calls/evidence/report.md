# Phase 1 Evaluation Report

生成时间: 2026-10-27T07:54:18.551Z
规则总数: 26 | 用例数: 21 | 注入预算: 1200 tokens

## 1. 检索策略对比（Baseline vs RAG vs Rule Retrieval）

| Strategy | Rule P | Rule R | Rule F1 | Feature P | Feature R | Ref Recall (RAG) | Avg Context Tokens | Avg Budgeted Tokens | Avg Rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | n/a | n/a | n/a | n/a | n/a | n/a | 0 | 0 | 0 |
| rag | n/a | n/a | n/a | n/a | n/a | 27.4% | 1175 | 1175 | 0 |
| rules | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | n/a | 2424 | 1045 | 14.9 |

> baseline / rag 不产出 Atomic Rule，因此规则与语义特征指标标记为 n/a；RAG 用 Ref Recall 衡量"检索到的文档片段是否覆盖期望规则引用的章节"。

## 2. validate 准确性（bad.java / good.java）

| Target | Cases | Violation P | Violation R | Errors | Warnings |
| --- | --- | --- | --- | --- | --- |
| bad.java (命中期望违规) | 21 | 100.0% | 100.0% | 50 | 38 |
| good.java (应为 0 个 error) | 20 | 100.0% | 100.0% | 0 | 0 |

## 3. Agent 在环指标

受控模型实验：已核对记录与产物哈希；model: deepseek-flash

| Strategy | Planned | Missing / Invalid | Avg Rule Compliance (N) | Violation Instances / Rules | Compile | Functional Test | Task Completion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 21 | 0 / 0 | 82.2% (20) | 62 / 53 | 21/21 (100.0%); evaluated 21 | 18/21 (85.7%); evaluated 21 | 0/21 (0.0%); evaluated 3 |
| rag | 21 | 0 / 0 | 85.6% (20) | 50 / 45 | 20/21 (95.2%); evaluated 21 | 18/21 (85.7%); evaluated 20 | 0/21 (0.0%); evaluated 3 |
| rules | 21 | 0 / 0 | 90.9% (20) | 41 / 29 | 21/21 (100.0%); evaluated 21 | 19/21 (90.5%); evaluated 21 | 0/21 (0.0%); evaluated 2 |

| Strategy | Case | Output | Compile | Test | Task |
| --- | --- | --- | --- | --- | --- |
| baseline | CASE-001 | present | ok | ok | not_run |
| baseline | CASE-002 | present | ok | ok | not_run |
| baseline | CASE-003 | present | ok | ok | not_run |
| baseline | CASE-004 | present | ok | ok | not_run |
| baseline | CASE-005 | present | ok | ok | not_run |
| baseline | CASE-006 | present | ok | failed | failed |
| baseline | CASE-007 | present | ok | ok | not_run |
| baseline | CASE-008 | present | ok | ok | not_run |
| baseline | CASE-009 | present | ok | ok | not_run |
| baseline | CASE-010 | present | ok | ok | not_run |
| baseline | CASE-011 | present | ok | ok | not_run |
| baseline | CASE-012 | present | ok | ok | not_run |
| baseline | CASE-013 | present | ok | ok | not_run |
| baseline | CASE-014 | present | ok | ok | not_run |
| baseline | CASE-015 | present | ok | ok | not_run |
| baseline | CASE-016 | present | ok | ok | not_run |
| baseline | CASE-017 | present | ok | failed | failed |
| baseline | CASE-018 | present | ok | ok | not_run |
| baseline | CASE-019 | present | ok | ok | not_run |
| baseline | CASE-020 | present | ok | failed | failed |
| baseline | CASE-021 | present | ok | ok | not_run |
| rag | CASE-001 | present | ok | ok | not_run |
| rag | CASE-002 | present | ok | ok | not_run |
| rag | CASE-003 | present | ok | ok | not_run |
| rag | CASE-004 | present | ok | ok | not_run |
| rag | CASE-005 | present | ok | ok | not_run |
| rag | CASE-006 | present | ok | failed | failed |
| rag | CASE-007 | present | ok | ok | not_run |
| rag | CASE-008 | present | ok | ok | not_run |
| rag | CASE-009 | present | ok | ok | not_run |
| rag | CASE-010 | present | ok | ok | not_run |
| rag | CASE-011 | present | ok | ok | not_run |
| rag | CASE-012 | present | ok | ok | not_run |
| rag | CASE-013 | present | ok | ok | not_run |
| rag | CASE-014 | present | ok | ok | not_run |
| rag | CASE-015 | present | ok | ok | not_run |
| rag | CASE-016 | present | ok | ok | not_run |
| rag | CASE-017 | present | ok | failed | failed |
| rag | CASE-018 | present | ok | ok | not_run |
| rag | CASE-019 | present | ok | ok | not_run |
| rag | CASE-020 | present | failed | not_run | failed |
| rag | CASE-021 | present | ok | ok | not_run |
| rules | CASE-001 | present | ok | ok | not_run |
| rules | CASE-002 | present | ok | ok | not_run |
| rules | CASE-003 | present | ok | ok | not_run |
| rules | CASE-004 | present | ok | ok | not_run |
| rules | CASE-005 | present | ok | ok | not_run |
| rules | CASE-006 | present | ok | failed | failed |
| rules | CASE-007 | present | ok | ok | not_run |
| rules | CASE-008 | present | ok | ok | not_run |
| rules | CASE-009 | present | ok | ok | not_run |
| rules | CASE-010 | present | ok | ok | not_run |
| rules | CASE-011 | present | ok | ok | not_run |
| rules | CASE-012 | present | ok | ok | not_run |
| rules | CASE-013 | present | ok | ok | not_run |
| rules | CASE-014 | present | ok | ok | not_run |
| rules | CASE-015 | present | ok | ok | not_run |
| rules | CASE-016 | present | ok | ok | not_run |
| rules | CASE-017 | present | ok | ok | not_run |
| rules | CASE-018 | present | ok | ok | not_run |
| rules | CASE-019 | present | ok | ok | not_run |
| rules | CASE-020 | present | ok | failed | failed |
| rules | CASE-021 | present | ok | ok | not_run |

## 4. 说明

- Java 编译使用真实 javac（默认 --release 21），缺失工具、超时、编译失败分别记录；不自动补桩或改写产出。
- 合规率按非 info 的已检查规则去重；无适用规则或语法无效时为 n/a。100% 离线召回衡量未裁剪规则集，不能代表预算裁剪后的覆盖率。
- Compile/Test/Task Rate 分母为每种策略全部计划用例；缺失、不可用、未执行单独记录并报告覆盖率，不能视为通过。21 个用例均有功能/运行行为断言，但尚未覆盖全部业务和异常分支。完整任务验收均需依据清单审查，不从合规率推断。

## 5. 检索明细（rules 策略）

| Case | Expected | Retrieved | P | R | Context Tokens |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | 12 | 12 | 100.0% | 100.0% | 2105 |
| CASE-002 | 14 | 14 | 100.0% | 100.0% | 2349 |
| CASE-003 | 16 | 16 | 100.0% | 100.0% | 2701 |
| CASE-004 | 12 | 12 | 100.0% | 100.0% | 2107 |
| CASE-005 | 17 | 17 | 100.0% | 100.0% | 2791 |
| CASE-006 | 17 | 17 | 100.0% | 100.0% | 2791 |
| CASE-007 | 17 | 17 | 100.0% | 100.0% | 2791 |
| CASE-008 | 13 | 13 | 100.0% | 100.0% | 2217 |
| CASE-009 | 15 | 15 | 100.0% | 100.0% | 2278 |
| CASE-010 | 17 | 17 | 100.0% | 100.0% | 2791 |
| CASE-011 | 20 | 20 | 100.0% | 100.0% | 3191 |
| CASE-012 | 1 | 1 | 100.0% | 100.0% | 88 |
| CASE-013 | 20 | 20 | 100.0% | 100.0% | 3266 |
| CASE-014 | 21 | 21 | 100.0% | 100.0% | 3369 |
| CASE-015 | 18 | 18 | 100.0% | 100.0% | 2747 |
| CASE-016 | 14 | 14 | 100.0% | 100.0% | 2241 |
| CASE-017 | 8 | 8 | 100.0% | 100.0% | 1445 |
| CASE-018 | 21 | 21 | 100.0% | 100.0% | 3369 |
| CASE-019 | 0 | 0 | 100.0% | 100.0% | 0 |
| CASE-020 | 21 | 21 | 100.0% | 100.0% | 3285 |
| CASE-021 | 18 | 18 | 100.0% | 100.0% | 2987 |

## 6. validate 明细

| Case | Target | Expected | Reported | P | R |
| --- | --- | --- | --- | --- | --- |
| CASE-001 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-001 TP-CONFIG-002 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CONFIG-001 TP-CONFIG-002 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-001 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-002 | bad | TP-CREATE-001 TP-CREATE-003 TP-CONFIG-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-002 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-002 | 100.0% | 100.0% |
| CASE-002 | good | TP-REJECT-004 | TP-REJECT-004 | 100.0% | 100.0% |
| CASE-003 | bad | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 | TP-CONFIG-005 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-001 | 100.0% | 100.0% |
| CASE-003 | good | - | - | 100.0% | 100.0% |
| CASE-004 | bad | TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-005 | TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-005 | 100.0% | 100.0% |
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
| CASE-010 | bad | TP-CREATE-004 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-004 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-CREATE-004 | 100.0% | 100.0% |
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
| CASE-018 | bad | TP-MONITOR-001 TP-CREATE-001 TP-CREATE-003 TP-REJECT-003 TP-SHUTDOWN-001 | TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 | 100.0% | 100.0% |
| CASE-018 | good | - | - | 100.0% | 100.0% |
| CASE-019 | bad | - | - | 100.0% | 100.0% |
| CASE-020 | bad | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-REJECT-003 TP-SHUTDOWN-001 TP-SUBMIT-001 TP-SUBMIT-003 TP-SUBMIT-004 | TP-CONFIG-004 TP-CREATE-001 TP-CREATE-003 TP-MONITOR-001 TP-SHUTDOWN-001 TP-SUBMIT-004 TP-REJECT-003 TP-SUBMIT-001 TP-SUBMIT-003 TP-SUBMIT-004 | 100.0% | 100.0% |
| CASE-020 | good | - | - | 100.0% | 100.0% |
| CASE-021 | bad | TP-SHUTDOWN-001 TP-CREATE-005 TP-MONITOR-001 TP-REJECT-003 TP-SUBMIT-005 | TP-CREATE-005 TP-MONITOR-001 TP-SHUTDOWN-001 TP-REJECT-003 TP-SUBMIT-005 | 100.0% | 100.0% |
| CASE-021 | good | - | - | 100.0% | 100.0% |
