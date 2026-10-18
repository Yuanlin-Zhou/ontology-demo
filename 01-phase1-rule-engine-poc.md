# Phase 1：Knowledge Rule Engine PoC

## 1. 目标

实现独立 Knowledge Rule Engine，验证：

> Semantic Feature + Atomic Rule 是否比普通 RAG 更适合 Coding Agent。

暂时不侵入 Cline。

---

## 2. PoC 范围

第一阶段只支持：

```text
Language: Java
Domain: ThreadPool
```

建议：

```text
20～30 Atomic Rules
20～50 Evaluation Cases
```

---

## 3. 目录

```text
knowledge-rule-engine/

├── knowledge/
│   └── java/
│       └── thread_pool/
│           ├── create.yaml
│           ├── config.yaml
│           ├── submit.yaml
│           ├── rejection.yaml
│           └── shutdown.yaml
│
├── analyzer/
├── matcher/
├── validator/
├── cases/
└── eval/
```

---

## 4. Atomic Rule

示例：

```yaml
id: TP-CREATE-001

name: 显式创建线程池

domain:
  - java
  - concurrency
  - thread_pool

applies_when:
  features:
    - THREAD_POOL.CREATE

description: >
  创建线程池时应显式配置关键参数。

priority: high

related_rules:
  - TP-QUEUE-001
  - TP-REJECT-001
```

Rule 要求：

- 唯一 ID。
- 一个 Rule 只表达一个约束。
- 必须定义 applies_when。
- 可包含正反例。
- 可关联其他 Rule。

---

## 5. Semantic Feature

第一阶段：

```text
THREAD_POOL.CREATE

THREAD_POOL.CONFIG.CORE_SIZE
THREAD_POOL.CONFIG.QUEUE
THREAD_POOL.CONFIG.REJECTION

THREAD_POOL.SUBMIT
THREAD_POOL.EXCEPTION

THREAD_POOL.SHUTDOWN
```

---

## 6. Code Analyzer

优先使用：

```text
Tree-sitter
或 JavaParser
```

例如：

```java
new ThreadPoolExecutor(...)
```

识别：

```text
THREAD_POOL.CREATE
```

例如：

```java
executor.submit(task)
```

识别：

```text
THREAD_POOL.SUBMIT
```

第一阶段优先使用确定性 AST Pattern，不依赖 LLM 完成所有分类。

---

## 7. Rule Matcher

输入：

```json
{
  "features": [
    "THREAD_POOL.CREATE",
    "THREAD_POOL.SUBMIT"
  ]
}
```

输出：

```json
{
  "rules": [
    "TP-CREATE-001",
    "TP-QUEUE-001",
    "TP-REJECT-001",
    "TP-SUBMIT-001"
  ]
}
```

第一阶段直接维护：

```text
Semantic Feature → Rule
```

映射即可。

---

## 8. 对外接口

Rule Engine 暴露两个核心能力。

### retrieve

```text
retrieve(code, filePath, task?)
```

返回：

```json
{
  "features": [
    "THREAD_POOL.CREATE"
  ],
  "rules": [
    {
      "id": "TP-CREATE-001",
      "content": "..."
    }
  ]
}
```

### validate

```text
validate(code, ruleIds?)
```

返回：

```json
{
  "violations": [
    {
      "rule_id": "TP-REJECT-001",
      "message": "线程池未正确配置拒绝策略"
    }
  ]
}
```

---

## 9. 第一次 Agent 实验

暂时不改 Cline。

执行：

```text
User Task
 ↓
读取目标代码
 ↓
Rule Engine.retrieve()
 ↓
Prompt 拼接 Applicable Rules
 ↓
Cline 执行任务
 ↓
Rule Engine.validate()
```

Prompt：

```text
原始任务：
给 OrderService 增加异步通知能力。

Applicable Engineering Rules:

[TP-CREATE-001]
...

[TP-QUEUE-001]
...

请完成任务并遵循以上规则。
```

---

## 10. Evaluation

对比：

```text
Baseline
vs
普通 RAG
vs
Rule Retrieval
```

主要指标：

```text
Rule Compliance Rate

Violation Count

Retrieval Precision

Retrieval Recall

Compile Rate

Test Pass Rate

Task Completion Rate

Context Token Cost
```

重点验证：

```text
Rule Compliance ↑
Context Token ↓
```

---

## 11. Phase 1 完成标准

```text
✓ Atomic Rule Repository

✓ Java AST Analyzer

✓ Semantic Feature Extractor

✓ Rule Matcher

✓ retrieve API

✓ validate API

✓ Evaluation Cases

✓ Baseline / RAG / Rule Retrieval 对比结果
```

只有 Phase 1 数据证明有效，才进入 Cline 深度集成。
