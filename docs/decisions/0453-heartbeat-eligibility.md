# ADR-0453: Heartbeat autorun eligibility — per-thread approval gate for scheduler + reactor

- **상태**: Accepted
- **날짜**: 2026-06-02
- **관련**:
  - ADR-0046 (permission state store — `ThreadPermission.approvalPolicy` is the policy axis this gate is a pure function of)
  - ADR-0131 (memory outcome 4-state — `priorOutcome` mirrors this enum)
  - ADR-0132 (autonomous proactive reactor — self-wake's 3 hard guards; this ADR adds an OPTIONAL 4th)
  - ADR-0161 (scheduled agent — `SchedulerRuntime.tickOnce` RRULE fire path; this ADR adds an OPTIONAL gate)
- **참조**:
  - `src/permission/autorun-eligibility.ts` — `evaluateAutorunEligibility(input) → { eligible, reason }` (PURE / TOTAL) + closed `AutorunEligibilityReason` enum.
  - `src/permission/index.ts` — barrel re-export.
  - `src/scheduler/types.ts` — `AutorunEligibilityResolverPort` / `AutorunVerdict` + `scheduler.skipped` `not-eligible` reason arm + `eligibilityReason`.
  - `src/scheduler/runtime.ts` — `SchedulerRuntimeOpts.eligibility?` + the gate (step 2b) in `processAutomation`.
  - `src/reactor/types.ts` — `AutorunVerdict` + `ReactorSelfWakeEvent` `not-eligible` reason arm + `eligibilityReason`.
  - `src/reactor/self-wake.ts` — `SelfWakeOpts.eligibility?` + the 4th guard in `injectSimulatedTurn`.
  - Tests: `tests/unit/heartbeat-eligibility-hellgate.test.ts` (18 cases).
  - Feature catalog: `tools/feature-catalog/features/09-integration/0453-heartbeat-eligibility.yaml`.

## 맥락

The scheduler (ADR-0161) and the proactive reactor (ADR-0132) both dispatch background auto-runs onto the same `AgentLoopPort`. Before this ADR neither consulted the per-thread approval policy (ADR-0046 `ThreadPermission.approvalPolicy`) that the **interactive** dispatch path already honors via the admissibility gate:

- `SchedulerRuntime.tickOnce` fired purely on the RRULE time-gate (`status === "active"` + `nextFire <= now`).
- The reactor's `injectSimulatedTurn` fired behind 3 hard guards (env flag / 30s quiet window / prior outcome `success|uncertain`) — none of which is the thread's approval policy.

A thread the user marked `approvalPolicy: "never"` could still be woken by a cron automation or a CI-completion self-wake. Codex's heartbeat-automation model gates the heartbeat on the same approval policy as foreground actions; this ADR absorbs that — structurally, with no new heuristic.

## 결정

A PURE, TOTAL evaluator in `@/permission`:

```
evaluateAutorunEligibility({ approvalPolicy, priorOutcome?, manualApprovalPresent?, mode? })
  → { eligible: boolean; reason: AutorunEligibilityReason }
```

Mapping (structural — no invented thresholds, no clock, no `Date.now`/`Math.random`):

| approvalPolicy | condition                          | eligible | reason                   |
| -------------- | ---------------------------------- | -------- | ------------------------ |
| `always`       | —                                  | ✅       | `policy-always`          |
| `never`        | —                                  | ❌       | `policy-never`           |
| `on-failure`   | `priorOutcome === "fail"`          | ✅       | `on-failure-failed`      |
| `on-failure`   | any non-failure / absent outcome   | ❌       | `on-failure-not-failed`  |
| `on-request`   | `manualApprovalPresent === true`   | ✅       | `on-request-present`     |
| `on-request`   | absent / false                     | ❌       | `on-request-absent`      |

`mode` is carried for audit anchoring ONLY — the verdict never branches on it (a `never` thread is ineligible in every mode). `reason` is a closed enum (not free text), so telemetry and tests assert WHY a fire was allowed/blocked.

Wiring — both paths consult an OPTIONAL injected resolver:

- **Scheduler**: `SchedulerRuntimeOpts.eligibility?: AutorunEligibilityResolverPort`. Consulted in `processAutomation` AFTER the status + RRULE-due gates, BEFORE model-resolve / persist / dispatch. A NOT-eligible verdict emits `scheduler.skipped / not-eligible` (with `eligibilityReason`) and returns WITHOUT advancing the fire anchor — the automation stays due and re-evaluates next tick once its policy / prior outcome changes.
- **Reactor**: `SelfWakeOpts.eligibility?: () => AutorunVerdict | undefined` — a 4th guard after the 3 hard guards. A NOT-eligible verdict emits `reactor.self_wake / skipped / not-eligible` and returns `{ injected: false, reason: "not-eligible", eligibilityReason }`.

The slice never imports `@/permission` in its hot path: each slice defines a local minimal `AutorunVerdict` shape (structurally compatible with `@/permission`'s `AutorunEligibility`); the **composition root** is the only place that reads the thread's policy from the permission store, calls `evaluateAutorunEligibility`, and maps the result onto the resolver. The evaluator itself lives in `@/permission` (it is a pure projection of `ThreadPermission.approvalPolicy`) and is re-exported through the `@/permission` barrel.

**Default-OFF / byte-identical**: when no resolver is injected, both paths are byte-identical to the pre-ADR-0453 code (scheduler still fires on RRULE; reactor still uses its 3 guards). A resolver that returns `undefined` ("no opinion") is also pass-through. The gate is purely *additive*: it can only BLOCK a fire the existing gate already permitted — never force one.

## 결과

- The autorun substrate now respects the same per-thread approval policy as the interactive dispatch path, closing the "`never` thread still gets woken" gap.
- No new env flag, no new heuristic, no clock in the evaluator — the verdict is a deterministic function of closed enums.
- Anchor-preservation on a blocked scheduler fire means a thread that flips from `never` to `always` (or whose prior outcome becomes `fail` under `on-failure`) fires on the very next tick with no missed-window or double-fire.

## Trade-offs

- The reactor resolver is a thunk (`() => AutorunVerdict | undefined`) rather than keyed by threadId, because self-wake operates on a single active surface — the composition root closes over the surface's threadId. If a future reactor multiplexes threads, the thunk becomes `(threadId) => …` (additive change).
- `manualApprovalPresent` for `on-request` is a structural boolean the composition root supplies (e.g. from a pending review/request record); this ADR does not define HOW that boolean is sourced — only that the verdict is a function of it.
