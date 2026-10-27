# Independent boundary evaluation

| Case | Rule | Expected violation | Detected | Known limitation |
| --- | --- | --- | --- | --- |
| queue-unbounded | TP-CONFIG-004 | true | true | false |
| queue-one | TP-CONFIG-004 | false | false | false |
| queue-underscored-max | TP-CONFIG-005 | true | true | false |
| queue-synchronous | TP-CONFIG-004 | false | false | false |
| future-with-timeout | TP-SUBMIT-002 | false | false | false |
| future-no-timeout | TP-SUBMIT-002 | true | true | false |
| threadlocal-finally | TP-SUBMIT-004 | false | false | false |
| threadlocal-leak | TP-SUBMIT-004 | true | true | false |
| cross-file-cleanup | TP-SUBMIT-004 | false | true | true |
| cross-file-field-queue | TP-CONFIG-004 | true | false | true |

Precision 80.0%; recall 80.0%; false positive rate 20.0%. Labels are human-authored; known limitations remain in the denominator. Each case tests one named rule, not complete-file compliance.

Apache BasicThreadFactory compatibility probe: 0 parse errors; 0 enterprise-rule findings. Upstream code is not labeled enterprise-compliant. See fixtures/real-world/README.md for provenance.
