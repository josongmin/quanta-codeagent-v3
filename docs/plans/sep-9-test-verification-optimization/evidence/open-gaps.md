# TV-90 open gaps — this session did not close these

Authoritative `verify:full --cache=off`, ABBA p95, and remote `ACTIVE_VERIFIED` were
out of scope. The overloaded 41-minute SIGINT campaign is not a performance baseline.

| Gap | Why it stays open |
|---|---|
| TV-08 B lease split | Deferred by plan. Admission A (single wait budget) only. |
| TV-09 PR exhaustive reduction | Canary added; 60-seed fuzz / bench cross-product stay on PR until a real nightly artifact exists. |
| TV-12 live matrix | Shadow jobs exist behind `vars.QUANTA_SHADOW_MATRIX`. Required still consumes `full-suite`. |
| TV-15 R2 hook switch | R0 is `REMOTE_UNVERIFIED`; `.githooks/pre-push` still calls `bun run prepush --bail`. |
| TV-15 R3 remote required | Ruleset PATCH forbidden this session. `pyramid` check name kept as aggregator; `required` is concurrent only. |
| TV-15 R4 selector promotion | PR skip authority stays inactive. |
| TV-90 cache-off full | Not started. |
| TV-90 ABBA p95 | No healthy-load sample. |
| KF-01 chunk 16 | `tests/unit/bench-full-remote-hellgate.test.ts` remains unresolved. Not quarantined. |

Selection dry-run and membership equality were checked in focused unit tests, not against a full campaign receipt.
