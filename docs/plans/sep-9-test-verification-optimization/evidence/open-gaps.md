# TV-90 open gaps — remaining items are external or plan-deferred

Owner wiring for selection, policy, declared-input digest, campaign timing,
admission spawn-0, matrix plan, first-failure, and required-needs aggregation
is in the tree. The items below are still open because the original plan
forbids starting them in this session.

| Gap | Why it stays open |
|---|---|
| TV-08 B lease split | Deferred by plan. Admission A (single wait budget + spawn=0) only. |
| TV-09 PR exhaustive reduction | Canary added; 60-seed fuzz / bench cross-product stay on PR until a real nightly artifact exists. |
| TV-12 live matrix | Shadow jobs exist behind `vars.QUANTA_SHADOW_MATRIX`. Required still consumes `full-suite`. |
| TV-15 R2 hook switch | R0 is `REMOTE_UNVERIFIED`; `.githooks/pre-push` still calls `bun run prepush --bail`. |
| TV-15 R3 remote required | Ruleset PATCH forbidden this session. `pyramid` check name kept as aggregator; `required` now evaluates `needs` JSON locally. |
| TV-15 R4 selector promotion | PR skip authority stays inactive. `verify-scope --json` is dry-run only. `verify:pr/full/nightly` now pass distinct `gate.ts` tiers; suite population is still the same until TV-09. |
| TV-90 cache-off full | Not started. |
| TV-90 ABBA p95 | No healthy-load sample. Campaign receipts now record lease/run phase timing without treating one sample as p95 proof. |
| KF-01 chunk 16 | `tests/unit/bench-full-remote-hellgate.test.ts` remains unresolved. Not quarantined. |
| Declared-v1 rollout | Identity field is live; opt-in set is empty so every chunk stays whole-tree. |

Selection dry-run and membership equality were checked in focused unit tests, not against a full campaign receipt.
