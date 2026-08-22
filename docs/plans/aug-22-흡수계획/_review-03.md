# _review-03 — RFC-03 ProposeGoal + verifiable evaluator + goal-editor (READ-ONLY review)

Reviewer pass over `rfc-03-goal-propose-edit.md`. Every cited file:line was opened and
verified against the real call path. Verdict at the bottom (Section I).

---

## A. Snapshot (start of review)

- HEAD = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4`
- origin/main = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` (HEAD == origin/main, in sync)
- branch = `main`
- dirty = 69 paths, ALL under `src/apps/bench/**`, `src/runner/batch/**`,
  `tools/leaderboard-dashboard/**`, `adapters/terminal-bench/**`,
  `docs/plans/aug-21-*` — i.e. a bench/TB campaign. **None touch `src/tool/objective`,
  `src/agent/objective`, `src/apps/cli/slash/goal-cmd.ts`, or `status-pills.ts`.** This
  review did not touch any dirty file. Only new file written: this `_review-03.md`.

---

## B. Existing objective features — verified real delta

Every "current state" claim in the RFC checks out against source:

| RFC claim | Verified at | Accurate? |
|---|---|---|
| model can already set goals via `objective_set`, tier `pre-approval-ok` | `src/tool/objective/index.ts:207` name, `:216` `hitlTier: () => "pre-approval-ok"` (same at `:286`/`:319` for update/get) | ✅ |
| completion is model self-marking (no evaluator) | `objective_update` `markCriterion{met:boolean}` schema `index.ts:116-120` → `store.ts:362` writes `met = met===true`; derivation "all criteria met ⇒ completed" documented `types.ts:100-110` | ✅ — nothing re-checks real state |
| pursuit discipline is prompt-only, not enforced | `pursuit-prompt.ts:24` `GOAL_PURSUIT_DISCIPLINE` string ("verify completion against the actual current state") — pure text handed to the model | ✅ |
| execution oracle exists only in bench grading | `src/runner/batch/eval/regression-oracle.ts` (injected exec port, verdict-codes, fail-open) — not reachable from the runtime agent loop | ✅ |
| CLI `/goal` is set/show/clear only | `goal-cmd.ts` — `clear`→`updateStatus("paused")` (`:50`), show (`:56`), set (`:78`). No edit/revert/updated-ago/replace-guard | ✅ |
| chip is text+elapsed, no 6-state label | `status-pills.ts:177` `formatGoal({text, elapsedMs})` renders `🎯 <text> · <elapsed>`; `updatedAt` exists (`types.ts:87`) but is not projected in | ✅ |
| HITL tier is per-input; `always-confirm`→onConfirm | `tool/types.ts:750` `hitlTier(input)`; `admissibility-gate.ts:165-171` HITL gate → `runHitlReviewGate`; `onConfirm` at `agent/types.ts:183` | ✅ |
| operator overrides are escalate-only ratchet | `hitl-tier-registry.ts:11-18` "clamped to a one-way ratchet … may ESCALATE … never DOWNGRADE" | ✅ |
| gates already wired | `objective-store-wire.ts:29` (`QUANTA_OBJECTIVE_TOOLS`), continuation ticker gated by `QUANTA_GOAL_ENFORCE` `goal-continuation-hook.ts:34-37` | ✅ |

**Conclusion:** the RFC's three-gap framing (a HITL, b evaluator, c editor UX) is honest and
non-inflated. It does NOT reinvent the 6-state machine, the store, or the continuation ticker —
those are confirmed reused. The "REFUTED: objective_set already lets the model set goals"
self-correction in the R1 audit log is accurate.

**Goal-persist entrypoints (full census):** exactly two today —
`goal-cmd.ts:78` (human `/goal`) and `index.ts:240` (`objective_set`, model). `propose_goal`
would be a **third**. No existing goal-editor / goal-version / goal-history store exists
(grep clean) — so D3 genuinely adds no duplicate store.

---

## C. `propose_goal` state transition + fail-closed — VERIFIED, with one structural hole

**Is it a duplicate wrapper of `objective_set`, or a distinct persist-post-approval transition?**

By the design as written it is a **distinct fail-closed transition, IF built as described**:
the admissibility gate runs `onConfirm` and, on deny, **short-circuits before `execute`**
(`admissibility-gate.ts` returns a `DispatchResult` to abort; `null` ⇒ proceed to execute).
Since the RFC puts `port.set(...)` *inside* the tool's `execute` (D1: "On approve: port.set…;
On deny: no-op `{ok:false}`"), a denied proposal never reaches `port.set` ⇒ **nothing persists
before approval**. `hitlTier(input)` is a pure classifier and does not persist. So the
fail-closed authoritative-state property holds *for the propose_goal tool in isolation*.

**BUT — the fail-closed property is defeated at the system level (the hole the RFC does not close):**

The RFC keeps `objective_set` **unchanged and additive** (D1 line: "propose_goal is additive to
objective_set; it does not remove or change the existing trio"; Current-state line 82: "existing
objective_set is pre-approval-ok"). `objective_set` writes the **same authoritative objective**
(`index.ts:240` → `port.set`) that the continuation ticker pursues — the ticker reads status via
`objective.get(threadId)` (`continuation.ts:294`) and is **agnostic to which tool set the goal**.

Therefore a model that wants to set/replace a persistent completion goal **without any approval
dialog simply calls `objective_set` instead of `propose_goal`.** The HITL gate on `propose_goal`
is *voluntary* — it gates one particular tool while an equivalent ungated tool sits beside it. All
of R3's bypass mitigations (shortcut-refused-on-replace, mandatory notice, escalate-only ratchet)
harden the `ask_user:false` path *within* propose_goal but do nothing about the wide-open
`objective_set` door. R3's decisive mitigation — "a set goal is inert unless `QUANTA_GOAL_ENFORCE`
is separately on" — is real (`goal-continuation-hook.ts:34-37`, ticker no-op when disabled) and
verified, so the blast radius is bounded to *non-autonomous* goal recording. **However, in the
intended "full" configuration (`QUANTA_PROPOSE_GOAL` + `QUANTA_GOAL_ENFORCE` both on), the model
gets ungated autonomous-pursuit goal-setting via `objective_set` — exactly what the HITL gate was
supposed to prevent.** This must be resolved before D1 lands (see H, D0).

**Reject / revise / approve / concurrent-replace — authoritative state + receipt:**

- **reject (deny):** execute never runs ⇒ no store mutation ⇒ authoritative state unchanged;
  receipt = `{ok:false}` tool result. ✅ well-defined by the gate short-circuit.
- **approve:** `execute` runs `port.set` + `updateStatus("active")`; receipt = rendered objective
  (`okResult`→`renderObjective`, `index.ts:169`). ✅
- **revise:** RFC has no explicit "revise during approval" transition — `onConfirm` returns
  boolean/`ConfirmDecision` (`agent/types.ts:183`); an edited-condition path is not specified.
  Today's approval kernel is approve/deny; "revise" would need the `ConfirmDecision` variant
  surfaced. **UNDER-SPECIFIED** — flag, not fatal.
- **concurrent replace:** store is single-objective-per-thread (`store.ts:281` `cells.set`), so a
  second approved `set` overwrites. The RFC's replace-guard is CLI-surface only; two model tool
  calls in one turn race on the store with last-write-wins. Since the store is synchronous and the
  loop is single-threaded per turn, this is a churn (not corruption) risk — acceptable but should
  be stated. The evaluator/continuation cross-mutation race is separately handled (see D).

---

## D. Oracle typing — BUILD / MEASURE / PARK

| Mode | What it is | Verdict | Rationale |
|---|---|---|---|
| **MODE A — execution oracle** (`check:{kind:"command",command,expectExitCode}`) | spawn command, compare exit code, then `markCriterion(met)` | **BUILD, default-OFF** | This is the only genuinely machine-verifiable path and the only real extension beyond Claude (Claude's evaluator judges from conversation = LLM-judge). Its shape is *already proven* in `regression-oracle.ts`: injected exec port, `timeoutMs`, verdict-codes discriminating "real verdict" from "couldn't run", fail-open on non-verdict. **Reuse that engine's contract**, not a new spawner. |
| **MODE B — LLM-judge** (no `check`) | second LLM call judges "condition met?" | **PARK / MEASURE-FIRST, default-disabled behind its own sub-flag** | Correctly self-diagnosed: an LLM judging an LLM is *not stronger than today's self-marking*. RFC does not claim efficacy and gates it separately. Correct call — do not BUILD until an A/B on SWE picks shows a real delta. |
| **FALLBACK — abstain** (no `check`, MODE B off) | evaluator does nothing; completion stays today's self-mark + "unverifiable" note | **BUILD (safety-critical)** | This is what prevents both (i) vacuous auto-complete of unverifiable conditions and (ii) never-completing runaway. Must be built *with* MODE A, not deferred. |

**Oracle execution environment — the unresolved crux (RFC Open-Q + R3 residual):**

The RFC leaves *how* `check.command` executes as an open question (bench `regression-oracle`
posture vs runtime bash-tool sandbox) and flags in R3 that this path "shares HITL/sandbox with
model commands — needs the sequencing open-Q resolved before build so the evaluator can't become a
sandbox-escape (run arbitrary `check.command` outside approval)." **This is correctly identified as
a live risk and correctly left OPEN — but it is a BUILD-BLOCKER for D2, not a nice-to-have.** The
task's prohibition ("임의 shell을 무제한 evaluator로 실행 금지") maps directly onto this:

- timeout: MUST use an explicit `timeoutMs` (regression-oracle already models this) — not unbounded.
- side effects / sandbox: `check.command` is a *live side-effecting exec* and MUST route through the
  same admissibility gate + HITL/sandbox the model's own bash obeys. The evaluator MUST NOT get a
  privileged exec bypass. RFC's "Lean: runtime bash path" is the correct direction — commit it.
- nondeterminism / false-positive/negative: exit-code oracle inherits the regression-oracle's
  robust posture (0 ⇒ pass, verdict-codes gate "real verdict"; anything else ⇒ abstain, never
  auto-complete). This is heuristic-free and the right model. **Add:** the check must re-run against
  the *current* tree at evaluation time (stale-SHA); a check captured at propose-time and never
  re-executed would be a false-positive. RFC's "per-turn evaluator that RUNS it" covers this if the
  hook actually spawns each turn (verify in impl).
- **Recommendation:** Do NOT reuse the bench `regression-oracle` *execution* posture (it runs in a
  bench sandbox tree with an injected bench exec port and PASS_TO_PASS provenance). Reuse its
  *engine contract shape* (exec-port + verdictCodes + fail-open `toRegressionGreen`) but drive it
  through the runtime bash/admissibility path so approval + sandbox are inherited.

---

## E. Duplicate owner / store / tool risk

1. **`propose_goal` vs `objective_set` (HIGH).** Two model-facing goal-setters writing the same
   authoritative objective, one HITL-gated and one not (Section C). This is the dominant duplication
   risk: it is not just redundant surface, it *nullifies the gate's security claim*. Resolve by
   escalating/unifying `objective_set`'s tier when `QUANTA_PROPOSE_GOAL` is on (D0), OR by routing
   both through one classifier. Adding a third ungoverned goal-setter is the wrong shape.
2. **Evaluator vs regression-oracle (LOW / reuse win).** No store duplication — the evaluator marks
   `met` through the existing `ObjectivePort.markCriterion`. The exec *engine* should reuse
   `regression-oracle.ts`'s contract (Section D) rather than re-implement a spawner. RFC already
   leans this way.
3. **Editor vs objective store (NONE).** D3 explicitly keeps the ADR-0394 port closed and holds the
   single-undo snapshot on the *surface* (`port.set` to restore). Grep confirms no existing
   goal-editor/version/history store — so no duplication. The one wiring note: `formatGoal` today
   receives a pre-projected `{text, elapsedMs}` (`status-pills.ts:177`); the 6-state chip needs the
   upstream projector to also thread `status` + `updatedAt` in — a small change at the projection
   site, not a store change.
4. **Continuation semaphore sharing (MEDIUM correctness).** D2's race guard requires the evaluator
   hook and the continuation ticker to acquire the **same `ContinuationSemaphore` instance**. Today
   the ticker *constructs its own* semaphore inside `goal-continuation-hook.ts` (imports
   `ContinuationSemaphore` and news it up). For the guard to hold, the semaphore must be hoisted to
   a shared owner both hooks receive by injection — otherwise two independent single-permit
   semaphores serialize nothing against each other. This is a real wiring requirement the RFC
   asserts but does not yet locate. Also note the semaphore is **global single-permit across all
   threads**, so a shared instance serializes evaluators across threads too (acceptable, but state it).

---

## F. Minimum write-set + dependencies

**D1 (`QUANTA_PROPOSE_GOAL`):**
- `src/tool/objective/propose-goal.ts` (new tool; captures `ObjectivePort`; `hitlTier(input)` reads
  `port.get(thread_id)` synchronously to resolve the shortcut-admissible check — feasible, `get` is sync).
- `src/agent/tier1/objective.ts` — `buildObjectiveBlock` currently composes from `config.objective`
  only and receives no gate/env; it must be threaded a `QUANTA_PROPOSE_GOAL` signal to append the
  tool. (Composition-root touch — the gate does not reach this builder today.)
- **D0 (new, see H):** escalate `objective_set` tier (or unify) when the propose gate is on.
- Tests: RED e2e `runAgent×scripted-LLM` (onConfirm fires; approve persists, deny no-op),
  ask_user bypass tier-resolution test.

**D2 (`QUANTA_GOAL_EVALUATE`):**
- `src/apps/cli/goal-evaluator-hook.ts` (new; mirrors `goal-continuation-hook.ts`).
- Shared `ContinuationSemaphore` ownership refactor so ticker + evaluator inject the *same* instance
  (Section E.4) — small but load-bearing.
- Exec routed through runtime admissibility/bash path (Section D) — depends on resolving the Open-Q.
- Reuse `regression-oracle.ts` engine contract (exec-port shape) — no new spawner.
- Tests: red-on-injection (exit0 ⇒ complete, exit1 ⇒ NOT complete), abstain-fallback test.

**D3 (`QUANTA_GOAL_EDITOR`):**
- `status-pills.ts` — `Record<ObjectiveStatus,string>` chip map (drift-guarded, mirror the two-way
  guard at `index.ts:49-62`) + projector change to pass `status`/`updatedAt`.
- `goal-cmd.ts` — new `/goal edit|revert|replace|pause|resume` verbs; surface-held single-undo slot.
- web/Tauri composer dialog (independently deferrable).
- Tests: editor round-trip (edit→updated-ago; revert restores exact prior objective; replace-guard).

**Shared dependency:** all three need `QUANTA_OBJECTIVE_TOOLS` on for the store to exist
(`objective-store-wire.ts:29`). All three must be byte-identical when OFF.

---

## G. RED-on-injection + real front-door receipt

- **Front-door proof (hellgate #1):** `runAgent` with a scripted model calling `propose_goal`,
  asserting the *real* `onConfirm` fires and, on approve, the store persists `status:active` with
  the condition as criterion. This is a genuine front-door (real loop × real gate), not a stub —
  correct and matches the repo's `runAgent×scripted-LLM==0` discipline.
- **Evaluator red-on-injection (hellgate #2):** spawn `bun -e 'process.exit(0)'` ⇒ completes; flip
  to `process.exit(1)` ⇒ MUST NOT complete. This is a *real spawned effect* with an injected
  ground-truth flip — the correct anti-vacuous shape (satisfies the "efficacy는 단위 테스트만으로
  주장 금지" bar at the *mechanism* level; efficacy itself stays measure-first per D/Section I).
- **ask_user bypass gate (hellgate #3):** asserts the *resolved tier* (not just output string) —
  correct (avoids the vacuous string-only assertion).
- **Byte-identical hellgate (#4)** + **enum drift guard (#5, mirrors `index.ts:60`)** are the right
  default-OFF and recurrence-prevention pins.

**Gap:** the front-door receipt suite does NOT include a test that the *ungated* `objective_set`
still sets a pursuable goal while `propose_goal` is gated — i.e. no test pins the Section C hole.
Add a red test: with `QUANTA_PROPOSE_GOAL` on, `objective_set` must be tier-escalated (post-D0) so
it cannot silently set an autonomously-pursued goal. Without D0 this test would (correctly) fail,
exposing the hole.

---

## H. D1/D2/D3 re-ordering + effort

RFC sequence is D1 → D3 → D2. That ordering (smallest/highest-parity first, most-audited last) is
sound. **One insertion required:**

- **D0 (new, MUST precede D1 landing, ~0.25 day): close the `objective_set` bypass.** When
  `QUANTA_PROPOSE_GOAL` is on, escalate `objective_set` to `always-confirm` (via the escalate-only
  registry that already exists, `hitl-tier-registry.ts`) *or* unify both tools behind one tier
  classifier. Without D0, D1's entire HITL value is decorative (Section C/E.1). This is not
  gold-plating — it is the difference between the feature doing what it claims and not.
- **D1** `propose_goal` — as written, ~1 day. Add the `tier1/objective.ts` gate-threading note.
- **D3** editor UX — ~1 day CLI + ~1 day web; add the `formatGoal` projector change.
- **D2** evaluator — RFC's ~1.5 days is optimistic *only if* the Open-Q (exec posture) and the
  shared-semaphore refactor are pre-resolved; budget ~2 days and treat the admissibility-routed exec
  as a hard prerequisite, not an open question, before any code.
- Measure-first A/B on SWE picks before any default-ON — correct, keep.

Revised total ≈ 5.75–6.5 days (D0 + semaphore refactor + realistic D2), MODE B and web dialog still
deferrable.

---

## I. Verdict — REVISE

The RFC is **honest, well-scoped, and mostly correct**: the three-gap delta is real and verified,
it reuses the store/state-machine/continuation-ticker instead of reinventing them, the evaluator is
correctly split into a genuinely-verifiable MODE A (BUILD, default-OFF, real red-on-injection) and a
measure-first MODE B (PARK), the abstain fallback prevents vacuity and runaway, and the default-OFF
+ drift-guard + front-door hellgate discipline is right. On the task's core tests it largely passes:
`propose_goal` *is* a persist-post-approval transition (not a wrapper), the evaluator *is* a
machine-verifiable oracle (MODE A) rather than model self-assessment, and "extension beyond Claude"
is correctly grounded in verifiability (execution oracle) rather than feature count.

**But it does not ship as-is because of one structural hole and two under-specifications:**

1. **BLOCKER — HITL gate is bypassable by design.** `objective_set` stays ungated and additive and
   writes the *same* authoritative goal the continuation ticker pursues. In the intended full config
   (`QUANTA_PROPOSE_GOAL` + `QUANTA_GOAL_ENFORCE`), a model bypasses approval entirely via
   `objective_set`. Requires **D0** (escalate/unify `objective_set` tier when the propose gate is
   on) + a red test pinning it. (Section C, E.1, G.)
2. **BLOCKER-for-D2 — evaluator exec posture is an open question, not a resolved contract.** "임의
   shell을 무제한 evaluator로 실행 금지" demands the `check.command` route through the runtime
   admissibility/HITL/sandbox path with an explicit timeout and current-tree (non-stale) execution,
   reusing `regression-oracle.ts`'s engine contract — not the bench sandbox posture, and never a
   privileged exec bypass. Must be closed *before* D2 code. (Section D.)
3. **REVISE — shared-semaphore wiring.** D2's race guard asserts a shared `ContinuationSemaphore`
   that does not exist yet (the ticker news up its own). Hoist to a shared injected owner. (Section E.4.)

Minor: "revise during approval" transition under-specified (Section C); `formatGoal` projector needs
`status`/`updatedAt` (Section E.3). Efficacy remains correctly measure-first / default-OFF — do not
claim it from unit tests.

**REVISE** — land D0 + the exec-posture decision + the semaphore hoist into the RFC before build;
the rest is ready.
