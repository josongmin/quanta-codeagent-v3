# TV-90 open gaps — remaining items are external or plan-deferred

Owner wiring for selection, policy, declared-input digest, campaign timing,
admission spawn-0, matrix plan, first-failure, and required-needs aggregation
is in the tree. The items below remain behind explicit rollout, external-service,
or healthy-load proof barriers; focused green does not authorize those switches.

| Gap | Why it stays open |
|---|---|
| TV-08 B lease split | Deferred by plan. Admission A (single wait budget + spawn=0) only. |
| TV-09 PR exhaustive reduction | Canary added; 60-seed fuzz / bench cross-product stay on PR until a real nightly artifact exists. |
| TV-12 live matrix | Shadow jobs now freeze an exact clean HEAD plan, fan out real Bun/JUnit workers, and fail closed on missing/stale/wrong-HEAD artifacts behind `vars.QUANTA_SHADOW_MATRIX`. No hosted artifact exists yet; required still consumes `full-suite`. |
| TV-15 R2 hook switch | Repository/default branch are verified, but protection capability is unavailable on the current private-repository plan; `.githooks/pre-push` still calls `bun run prepush --bail`. |
| TV-15 R3 remote required | Ruleset and branch-protection reads return HTTP 403 on the current plan, so a required context cannot be proved or enforced. `pyramid` remains the intended aggregator; `required` evaluates `needs` JSON locally. |
| Exact-HEAD hosted receipt | CI run `34377504975` targets `dba37472ec70acad1a38721a50a0693583333cd3`, but all seven jobs started zero steps because Actions reported a billing/spending-limit block; `required` was skipped. This is not a code-failure receipt. |
| TV-15 R4 selector promotion | PR skip authority stays inactive. `verify-scope --json` is dry-run only. `verify:pr/full/nightly` now pass distinct `gate.ts` tiers; suite population is still the same until TV-09. |
| TV-90 cache-off full | Not started. |
| TV-90 ABBA p95 | No healthy-load sample. Campaign receipts now record lease/run phase timing without treating one sample as p95 proof. |
| Declared-v1 rollout | Identity field is live; opt-in set is empty so every chunk stays whole-tree. |
| TV-13 nightly exhaustive groups | `NIGHTLY_MEMBERSHIP.includes` is `cache-off-full-suite` only — the lane `verify:nightly` actually runs. exhaustive-fuzz / quarantine-lane / toolchain-matrix stay unwired until TV-09/12 jobs exist. |

Repository visibility is no longer unknown; remote enforcement and hosted execution remain externally blocked. Selection dry-run and membership equality were checked in focused unit tests, not against a full campaign receipt.
KF-01 is owner-local green (`bench-full-remote-hellgate`); it is not a cache-off full receipt.
