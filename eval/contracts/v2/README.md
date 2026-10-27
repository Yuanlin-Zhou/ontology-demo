# Observable business contract v2

Version 2 is opt-in through `businessContractVersion: 2` in an experiment config. Missing version remains v1. Prompt construction, Java acceptance selection, report provenance and Repair use the recorded version; old experiment records are not regraded under v2. `eval/observable.example.json` prepares a targeted comparison of nine cases / three strategies / at most 27 model calls. No model calls are made by preparing prompts.

Seven previously underspecified business boundaries now use real, injectable callbacks:

| Case | Configured constructor | Async entry | Observable effect |
| --- | --- | --- | --- |
| 001 | OrderAsyncService(Consumer<Order>) | notifyCreated(Order) | sender receives the original order |
| 002 | OrderSyncService(Consumer<Order>, Function<String,Order>) | syncCreated(Order) | synchronizer receives order and its tenant; reload returns loader result |
| 003 | ReportExportService(Consumer<String>) | export(String) | exporter receives report ID |
| 007 | AsyncLogWriter(Consumer<String>) | write(String) | sink receives the original message |
| 008 | InventorySyncService(Consumer<String>) | sync(String) | synchronizer receives SKU; rejected SKU enters retryQueue |
| 010 | FileProcessService(Consumer<String>) | process(String) | handler receives file ID on named file-process worker |
| 011 | RealtimePushHandler(Consumer<String>) | onEvent(String) | receiver gets consecutive event IDs through the same pool |

No-arg constructors remain public but fail explicitly when no callback has been configured. The configured public constructors reject null callbacks. This defines a local business boundary, not an integration with a production notification, inventory, file or event service. The seven Java files here are Agent-authored executable references, not model experiment outputs or replacements for historical cases/*/good.java.

`BusinessAcceptance.java` checks actual callback invocations, original payloads, asynchronous return under a blocked worker, service-owned queueing, exact success/failure/rejection counters, failure isolation and later delivery, queue saturation, rejected SKU compensation, context restoration, drain on stop and closed-state rejection. It distinguishes a real sink from an empty method that merely increments counters. CASE-002 also checks loader's normal result. Its reload timeout/interruption behavior remains a requirement, but the v2 acceptance does not claim complete coverage of every loader exception path.

Shared stats are Map<String,Long>: submitted/completed/failed/rejected describe only async entry tasks, excluding reload. References retain forced-stop pending Runnables and cancel drained Future handles; the fixture primarily exercises normal drain. Long-running uncooperative callbacks require broader lifecycle review. Callback state observed in the test is the scoped task effect; real external business semantics still need domain-specific contracts.

The existing CASE-006 and CASE-020 injected callback contracts are unchanged. Their correct reference implementations already handle bounded priority replacement, actual task cancellation and completion of waiting callers on forced shutdown. This revision strengthens rule text and negative tests around tied eviction age and wrapper identity. Their original model failures remain frozen.

Prepare a new run without sending code to a provider:

```bash
node eval/experiment.ts eval/observable.example.json .eval-cache/observable-v2-prepared --prepare
```

Executing that new model experiment consumes a separate budget; prepare-only artifacts are not generation evidence. Use a fresh output directory and preserve the first-pass report. Reproducible environment: `npm run setup:eval`, `npm run check:eval`, `npm run test:eval`.
