# Agent paired experiment

Model: deepseek-chat; temperature: 0; repetitions: 3.

| Strategy | Attempts | Compliance (scored) | Violations | Compile | Task completion | Prompt tokens | Output tokens | Total tokens (coverage) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 12 | 83.3% (12) | 24 | 100.0% | 100.0% | 2514 | 1970 | 4484 (12/12) |
| rag | 12 | 87.5% (12) | 12 | 100.0% | 100.0% | 14271 | 2528 | 16799 (12/12) |
| rules | 12 | 86.1% (12) | 13 | 100.0% | 100.0% | 9234 | 4003 | 13237 (12/12) |

Task completion = compilation + fixed behavioral harness passed. Generation failures count as incomplete. Compliance = fraction of distinct checked rules without findings (including info); parse failures and zero applicable rules are unscored. Token costs are provider usage, not estimates; missing usage is explicitly counted. No monetary price is assumed. No repair feedback. Harnesses are not sent to the model. Small synthetic production-style tasks do not establish real-project generalization or Cline integration effectiveness.
