# Real-world compatibility fixture

Unmodified Apache Commons Lang `BasicThreadFactory.java`, release `rel/commons-lang-3.17.0`:

https://github.com/apache/commons-lang/blob/rel/commons-lang-3.17.0/src/main/java/org/apache/commons/lang3/concurrent/BasicThreadFactory.java

Downloaded 2026-10-27. SHA-256: `b33e483fadd97330e457f652da2549db5065d07ff37a69ad3c6e394215d6bb41`.

Apache-2.0; upstream license header, LICENSE.txt and NOTICE.txt are retained.

This is a parser / feature / validator compatibility probe on a real implementation of ThreadFactory, including a builder and configurable naming policy. It is not used to infer enterprise-policy ground truth, and is not sent to the model in the paired functional benchmark. It references Commons Lang classes; this fixture is analyzed statically, not claimed to compile standalone. The four executable Agent tasks are separately authored production-style simulations, not extracted from Apache.
