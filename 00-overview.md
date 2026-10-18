# 基于代码语义的 Agent 精准知识召回方案

## 1. 目标

将企业研发规范从“文档”转化为可计算的原子规则，并根据当前代码语义，只向 Coding Agent 注入真正适用的少量规则。

最终目标：

> 在 Cline Agent 编码过程中，根据当前操作的代码自动召回适用规范，并在代码生成后进行规则校验。

核心流程：

```text
Code
 ↓
Semantic Feature
 ↓
Applicable Rule
 ↓
Agent Context
 ↓
Generate
 ↓
Validate
 ↓
Repair
```

即：

```text
Retrieve → Generate → Validate → Repair
```

---

## 2. 核心概念

### Atomic Rule

规范的最小知识单元。

例如：

```text
TP-CREATE-001
TP-QUEUE-001
TP-REJECT-001
TP-SHUTDOWN-001
```

### Semantic Feature

从代码中识别出的工程语义。

例如：

```text
THREAD_POOL.CREATE
THREAD_POOL.SUBMIT
THREAD_POOL.SHUTDOWN
TRANSACTION.REMOTE_CALL
```

### Rule Applicability

建立：

```text
Code
→ Semantic Feature
→ Applicable Rule
```

例如：

```text
new ThreadPoolExecutor(...)

→ THREAD_POOL.CREATE

→ TP-CREATE-001
→ TP-QUEUE-001
→ TP-REJECT-001
```

---

## 3. 总体架构

```text
              Knowledge Repository
                       │
                 Atomic Rules
                       │
                       ↓
Code → Analyzer → Semantic Feature
                       │
                       ↓
                  Rule Matcher
                       │
                       ↓
                 Applicable Rules
                       │
                       ↓
                  Cline Agent
                       │
                       ↓
                 Generate Code
                       │
                       ↓
                  Validator
```

---

## 4. 实施阶段

### Phase 1：独立 Rule Engine PoC

暂时不修改 Cline。

实现：

```text
Java Code
→ AST
→ Semantic Feature
→ Rule Matcher
→ Applicable Rules
```

验证：

> 精准规则召回是否能够提升 Agent 规范遵循率。

### Phase 2：Cline Tool 集成

给 Cline 增加：

```text
knowledge_retrieve
knowledge_validate
```

Agent 主动调用知识能力。

流程：

```text
Cline
 ↓
read code
 ↓
knowledge_retrieve
 ↓
Generate
 ↓
knowledge_validate
 ↓
Repair
```

### Phase 3：Cline Runtime 自动集成

不再依赖模型主动调用知识工具。

利用 Cline Plugin / Runtime Hook：

```text
Agent读取代码
 ↓
自动分析
 ↓
自动召回规则
 ↓
自动注入下一轮模型Context
 ↓
Agent生成代码
 ↓
自动Validate
```

最终形成：

> Knowledge-aware Cline Agent

---

## 5. PoC 原则

第一阶段优先验证核心假设：

- Java 单语言。
- ThreadPool 单领域。
- 20～30 条 Atomic Rule。
- 20～50 个 Coding Case。
- AST + Pattern Matching 为主。
- YAML / JSON 保存 Rule。
- 暂不建设 Neo4j。
- 暂不建设完整 Knowledge Graph。
- 暂不修改 Cline Agent Loop。

验证成功后再增加：

```text
CodeGraph
Knowledge Graph
Ontology
Data Flow
Runtime Hook
```
