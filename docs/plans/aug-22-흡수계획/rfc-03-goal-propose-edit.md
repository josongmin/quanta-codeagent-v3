# RFC-03 — ProposeGoal (model-proposed goal under HITL) + verifiable condition/evaluator + goal-editor UX

**Status:** **R6 ARCHITECTURE FROZEN — authority/persistence cutover first; evaluator PARKED**
Absorption target from the 2026-08-13 refresh: Claude Code 2.1.238 `ProposeGoal`
(`.extracted_source/_deep-claude-2.1.238.md §1`) + Codex 6662 thread-goal inline editor
(`.extracted_source/_deep-codex-ui-med.md §1`). Adversarial review `_review-03.md` = **REVISE**
(3-gap framing + "propose_goal is not a wrapper" CONFIRMED); its 3 corrections are folded below.

---

## Final audit incorporation — current-HEAD authority (R5)

> R5 and the revised D0–D3/TDD/Sequencing are authoritative. Earlier “registry escalation,”
> `ask_user:false`, replacement-confirm, shared-global-semaphore, and surface-local exact-revert
> designs are superseded.

The prior plan does not close the goal-mutation boundary:

- HITL registry entries are static and tool-name based; they cannot be injected at composition or
  classify only `objective_update.markCriterion`.
- `always-confirm` falls through when generic HITL is disabled, so the feature gate does not itself
  guarantee approval on every surface.
- `ask_user:false` has no user-message provenance and remains an autonomous goal-set door.
- `SuccessCriterion` stores no executable check or verifier provenance, while model self-marking
  remains completion-authoritative.
- `ConfirmDecision` has no replacement-string variant, and `ObjectivePort.set` cannot restore an
  exact prior objective.

### Final disposition

| Slice | Verdict | Admission condition |
|---|---|---|
| Existing objective store/state/ticker/tools | ALREADY | Reuse, but all mutations pass D0 when gate ON |
| D0 objective mutation authority | **BUILD FIRST** | Bound thread identity, operation-aware policy, fail-closed confirmation capability |
| D1 propose_goal | BUILD after D0 | No `ask_user:false`; condition/check persist only after approval |
| D3 read-only chip + updated-at | BUILD | Pure projection |
| D3 multi-surface edit/revert | BUILD after CAS revision port | One durable authority, no surface-local undo |
| D2 MODE A evaluator | **PARK** | Check schema, verifier-only completion, execution lease, snapshot CAS, timeout/cancel all exist |
| MODE B LLM judge | MEASURE/PARK | Never completion-authoritative without efficacy evidence |

### Canonical objective mutation authority

Introduce one `ObjectiveMutationGatePort` at the ObjectivePort mutation boundary. Every model,
CLI, web, continuation, and evaluator mutation supplies:
`{threadId, actor, operation, expectedRevision, proposedPayload}`. When `QUANTA_PROPOSE_GOAL` is ON:

1. model-originated set/replace/criterion-completion requires the gate;
2. missing confirmation capability is typed `unavailable`, never approval bypass;
3. thread identity is bound from ToolContext/composition, never trusted from model input;
4. operation classification is structural (`set`, `replace`, `mark-model`, `mark-verifier`,
   `pause`, `resume`, `clear`, `restore`), not tool-name-only;
5. no store effect occurs before the gate returns an admitted receipt.

`ask_user:false` is **DROP** until a cryptographically/structurally bound user-message provenance
owner exists. A model boolean and “no active goal” are not provenance.

### Machine-verifiable criterion authority

Extend the existing objective schema/store, not a parallel evaluator store:

```
SuccessCriterion {
  id; text; met;
  check?: { kind:"command"; argv:string[]; cwdPolicy:"thread"; timeoutMs:number;
            successExitCodes:number[] }
  completion?: { source:"model"|"verifier"; verifiedAt:number; sourceDigest?:string }
}
```

- Checked criteria reject model `markCriterion(met:true)`; only `VerifierCompletionPort` can set
  them with matching objective revision + source digest.
- Free-form criteria retain explicit model completion and are labeled advisory, not machine-proof.
- Objective snapshot/codec/migrations and every exhaustive projector are part of the write-set.

---

## Architecture integration — R6 (normative)

R6 makes objective a first-class domain authority instead of continuing to grow
`src/agent/objective`. It also replaces surface-local undo, static tool-name HITL escalation and a
process-global evaluator semaphore. The shared authority graph is defined in
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Objective model/store/continuation | `src/agent/objective/{types,store,continuation,...}.ts` | Atomically promote into `src/objective/` |
| Objective tools | `src/agent/tier1/objective.ts` and existing tool adapters | Keep as thin actor adapters |
| Current construction | CLI `surface-compose/core-state.ts`, host `objective-store-wire.ts`, and agent `observability-wire/wire.ts` fallback can each create a store | Replace every production constructor/fallback; assembly owns lifetime/restore |
| Session persistence | `src/session/types.ts`, `src/session/store.ts` | Extend existing SavedSession; no goal JSON twin |
| Confirmation | existing HITL/confirm ports | Inject as a policy port; do not mutate the static registry at runtime |
| Workspace mutation | normal agent/tool path | Share one workspace barrier before admitting evaluator execution |

### Target write set and atomic move

```text
src/objective/
  model.ts            # Objective, Criterion, revision, provenance, updatedAt
  mutations.ts        # closed mutation union
  authority.ts        # prepare/commit/restore; only writer
  store.ts            # evolved current store
  ports.ts            # mutation policy, persistence, clock/id, execution ports
  criteria/
    model.ts           # declared check vs completion evidence
    verifier.ts        # verifier-only checked completion
  execution/
    lease.ts           # objective execution lease
    lifecycle.ts       # timeout/cancel/snapshot/CAS
  continuation.ts
  pursuit-prompt.ts
  usage-limit-wire.ts
  index.ts
src/agent/objective/                 # deleted in the cutover commit
src/agent/tier1/objective.ts         # thin adapter to authority
src/agent/objective-execution/workspace-barrier.ts
src/runner/assemble/session-authorities/build-objective.ts
src/host/runtime/objective-store-wire.ts # bind supplied authority; no independent store
src/agent/observability-wire/wire.ts     # remove objective-store fallback mint
src/apps/cli/repl/surface-compose/core-state.ts # consume narrow assembled port
src/session/{types,store}.ts         # optional versioned objective snapshot
src/protocol/session/{commands,codec,builders}.ts
src/apps/cli/slash/objective.ts
tests/unit/objective/
tests/integration/objective-authority-frontdoors.test.ts
```

Add `objective` to `SLICE_BOUNDARY_CONFIGS` in the same packet as the move. It is a leaf domain:
no value imports from agent, tool, session, permission, runner, host, protocol, or apps. Do not
leave a compatibility re-export under `src/agent/objective`; all imports change atomically so there
is one owner after the commit.

### Authority and mutation protocol

```ts
interface ObjectiveAuthority {
  read(): ObjectiveSnapshot
  prepare(command: ObjectiveMutationCommand): PreparedObjectiveMutation
  commit(prepared: PreparedObjectiveMutation, approval: ApprovalReceipt): CommitResult
  restore(previous: ObjectiveSnapshot, expectedRevision: number): CommitResult
}
```

`prepare` validates bound thread identity, actor, operation kind, expected revision, policy and
payload without mutating state. Model-originated proposals/edits and completion changes always
produce an approval requirement when the RFC gate is ON. The authority then releases its lock,
awaits the existing HITL adapter, and commits with CAS against the prepared revision. Approval
waiting under a store lock is forbidden.

The command record contains `{threadId, actor, operation, expectedRevision, payload}`. Thread id
comes from session composition, never model input. There is no `ask_user:false` bypass. CLI/web
editing and `objective_set` use the same authority; `session.objective.mutate` is the existing
kernel/host command-bus extension, not another mutation path.

Undo stores or returns the immutable prior snapshot and uses `restore(previous, expectedRevision)`.
It restores ids, ordering, blockers, next actions, met flags, provenance and status exactly. A
stale revision returns conflict; it never overwrites a later edit.

### Persistence and restore

`SavedSession` gains an optional versioned objective snapshot. The current session-store save,
archive, import/export and crash-resume paths preserve it. Missing data means legacy/no objective,
not an inferred default. Restore order is session identity -> saved objective -> policy binding ->
authority construction -> host projection -> first turn. The CLI no longer creates an independent
store.

The durable snapshot is the domain state, not an event-log fold. Kernel echoes are projections and
cannot restore the authority.

### Criterion and execution boundary

A criterion separates declaration from evidence:

```ts
type Criterion =
  | { kind: "manual"; text: string; completion?: ManualCompletionReceipt }
  | { kind: "checked"; text: string; check: CheckSpec; completion?: VerifierReceipt }
```

- A model may propose `CheckSpec`; it cannot mint `VerifierReceipt` or mark a checked criterion.
- Manual completion requires an explicit actor receipt; it is not silently upgraded to checked.
- Completion is CAS-bound to objective revision, workspace/source digest, check identity and
  verifier result.

MODE A execution stays PARKED until a non-shell `RuntimeProcessPort` reuses current sandbox, env,
redaction, cancellation and output caps. It must acquire the same per-workspace mutation barrier
used by normal turns/file tools, snapshot source state, run with timeout/cancel, then CAS commit.
An objective-only lease or global semaphore does not serialize the workspace and is insufficient.
MODE B LLM judgment never becomes completion authority.

### Atomic landing plan

1. **C0 — domain promotion:** move current objective code, add fence, update all imports, prove no
   old path/re-export remains.
2. **C1 — authority/CAS:** closed mutation union, actor/thread binding, prepare/commit and exact
   restore. Route every existing mutation through it.
3. **C2 — persistence/assembly:** extend SavedSession and remove CLI, host-wire and observability-
   wire production constructors/fallbacks before exposing another surface.
4. **C3 — HITL/front doors:** model proposal plus CLI edit use the same command and revision. Add
   read-only projection/chip.
5. **C4 — checked criteria schema/provenance:** persist declaration but keep evaluator disabled.
6. **C5 — evaluator later:** only after runtime process port and shared workspace barrier are live.

### Executable work packets

Use [`01-execution-board.md`](./01-execution-board.md). C0–C2 are authority cutover packets and
must merge serially. Do not parallelize import migration, store semantics and persistence against
the same objective files.

#### C0 — atomic domain promotion (`codex/aug22-c0-objective-slice`)

- **Prerequisite/owner:** attention/activity shared assembly packets merged or rebased; owns the
  complete `src/agent/objective/**` move, new `src/objective/**`, architecture config/test, and every
  direct import found by `rg -n '@/agent/objective|\.\./objective' src tests`.
- **Required import consumers:** `src/tool/objective/index.ts`, agent tier1/features/types,
  approval-state-machine, observability wire, host objective wire, CLI core-state and their tests.
- **RED first:** add `tests/unit/objective-slice-boundary.test.ts`; inject a temporary objective ->
  agent value import and prove the scanner names it. Pin current objective unit/integration output
  before moving.
- **Implement:** move types/store/continuation/prompt/usage files with behavior unchanged, add
  objective to peer deny lists, update all imports, delete the old folder and forbid a compatibility
  barrel.
- **Verify:** objective unit tests, `objective-usage-limited-429-real-loop-e2e`, objective/agent/tool/
  host/session boundary tests, typecheck and god-code ratchet.
- **Receipt:** `rg '@/agent/objective|src/agent/objective' src tests` returns zero and pre/post behavior
  fixtures are equal. **Stop** if a compatibility re-export or broad allowlist is required.

#### C1 — revisioned mutation authority (`codex/aug22-c1-objective-authority`)

- **Prerequisite/owner:** C0; owns `objective/{model,mutations,authority,store,ports}.ts`,
  `tool/objective/index.ts`, `agent/tier1/objective.ts`, approval-state-machine adapters and
  `tests/unit/objective/{authority,mutation-completeness}.test.ts`.
- **RED first:** concurrent mutations at revision N both succeed today; model `markCriterion` can
  self-complete; surface-local set cannot exact-restore. Pin all three failures.
- **Implement:** closed operation union, actor/thread binding, `prepare/commit/restore`, per-domain
  revision, immutable prior snapshot and CAS. Route every existing set/update/continuation writer
  through the authority while preserving gate-OFF behavior.
- **Verify:** authority table, two-writer race, exact restore, operation-completeness ratchet,
  existing objective tools integration and typecheck.
- **Receipt:** exactly one of two writers commits; stale undo preserves the winner; deleting any
  live authority call makes the completeness test RED. **Stop** if thread identity comes from model
  input or if an operation remains a direct store call.

#### C2 — persistence and single construction (`codex/aug22-c2-objective-persistence`)

- **Prerequisite/owner:** C1 and previous session-assembly owner merged; exclusive lock on
  `session/{types,store}.ts`, `runner/assemble/session-authorities/{types,build,build-objective,restore}.ts`,
  host objective wire, agent observability wire and CLI core-state.
- **RED first:** real save/close/reopen loses objective ids/revision/provenance; constructor scan
  finds CLI/host/observability store mints.
- **Implement:** versioned SavedSession DTO + strict objective decoder/encoder adapter, fixed restore
  order, one constructed authority, removal of all production fallback stores. Session stores JSON;
  it does not value-import objective domain behavior.
- **Verify:** restart/import-export/crash-resume tests, constructor-owner ratchet, session/objective/
  runner/host/agent boundaries and typecheck.
- **Receipt:** fresh runtime restores byte-equivalent snapshot and exactly one production factory
  owner remains. **Stop** if persistence requires a second file/store or kernel event replay.

#### C3 — HITL proposal/edit/front doors (`codex/aug22-c3-objective-hitl-ux`)

- **Prerequisite/owner:** C2; follows A4 in protocol lock. Owns objective command additions in
  protocol/kernel/host, `apps/cli/slash/objective.ts`, objective tool adapter and HITL adapter.
- **RED first:** model proposal commits without approval when the feature gate is ON; CLI edit and
  model tool do not conflict on one revision; revised confirmation variant is unavailable.
- **Implement:** model mutations prepare then release lock and await existing confirm port; approval
  receipt commits by CAS. CLI edit uses `session.objective.mutate`; a revision request creates a new
  prepare cycle rather than mutating the approved candidate.
- **Verify:** approval allow/deny/timeout/stale tests, protocol codec/scheduler tests, CLI objective
  command test, real objective tool integration and gate-OFF prompt/output snapshot.
- **Receipt:** denial changes nothing, approval commits once, simultaneous CLI/model edit yields one
  stale result. **Stop** on `ask_user:false`, static registry escalation, or lock-held approval wait.

#### C4 — criterion declaration/provenance (`codex/aug22-c4-objective-criteria`)

- **Prerequisite/owner:** C3; owns `objective/criteria/{model,verifier}.ts`, model/persistence schema,
  tool input adapter and criterion tests. It does not own process execution.
- **RED first:** checked criterion can currently be marked met through model update without verifier
  evidence; manual/checked completion provenance is absent after restart.
- **Implement:** manual/checked union, immutable CheckSpec, explicit completion receipt types and
  verifier-only checked transition. Persist schema and expose read-only projection; execution port
  remains an unsupported adapter.
- **Verify:** model self-mark rejection, manual receipt, checked verifier receipt, persistence
  roundtrip, schema migration and exhaustive decoder tests.
- **Receipt:** every checked completion contains check id, objective revision, source digest and
  verifier result. **Stop** if a placeholder receipt can be minted by the model/tool payload.

#### C5 — execution oracle (PARKED, no branch)

Unpark only after a non-shell `RuntimeProcessPort` and a workspace mutation barrier used by normal
turn/file mutations both have production owners. The authorized RED must race an evaluator with a
normal edit and prove mixed-state completion is rejected. Direct `Bun.spawn`, an objective-only
semaphore, shell-string checks or source digest captured outside the barrier invalidate the packet.

### Architectural completion gates

- A mutation-completeness ratchet enumerates every operation and every front door; deleting a live
  authority call makes it RED and the scan has a non-zero floor.
- A constructor-owner ratchet permits `createObjectiveStore()` only inside the objective authority
  builder/test fakes; it matches calls and fails if CLI, host wire or observability wire mints one.
- Concurrency rail: two edits at one revision yield one commit and one conflict; undo cannot clobber
  the winner.
- Gate-OFF rail is byte/prompt/session-snapshot compatible with the legacy behavior.
- Resume rail proves the same ids/revision/provenance survive a real store close/reopen.
- Checked-criterion rail proves every model/self-mark path is rejected and only verifier evidence
  can complete it.
- Evaluator rail, when unparked, races a normal file mutation and proves the shared barrier and
  source CAS prevent mixed-state completion.

**R6 status:** C0–C4 architecture is frozen; evaluator remains PARKED. RFC-03 is not implementation
FINAL until the authority and persistence cutover close.

---

## Prior review incorporation (R4, superseded where R5 conflicts)

`_review-03.md` (verdict **REVISE**) opened every cited `file:line` against the real call path and
**confirmed** the RFC's three-gap framing (a HITL, b evaluator, c editor UX) and that `propose_goal`
is a *distinct persist-post-approval transition, not a wrapper* of `objective_set`. Three corrections
are folded into this FINAL version:

1. **BLOCKER — the HITL gate is bypassable by a sibling door → new D0.** `objective_set` is
   ungated (`hitlTier: () => "pre-approval-ok"`, `src/tool/objective/index.ts:216`; tool name at
   `:207`) and this RFC keeps it **additive/unchanged**. It writes the **same authoritative
   objective** (`index.ts:240` → `port.set`) that the continuation ticker pursues — and the ticker is
   **agnostic to which tool set the goal** (`continuation.ts:294` reads `objective.get(threadId)`).
   So in the intended full config (`QUANTA_PROPOSE_GOAL` + `QUANTA_GOAL_ENFORCE` both on) the model
   sets an **autonomous-pursuit goal via `objective_set` with NO approval dialog** — exactly what the
   gate was meant to prevent. R3's bypass defenses only harden `propose_goal`'s *internals*; they do
   nothing about this door. **Fix = D0** (below): when the propose gate is ON, escalate
   `objective_set`'s tier to `always-confirm` via the escalate-only registry (or unify both setters
   behind one classifier), with a red-on-injection test that `objective_set`-under-propose-gate
   requires approval. D0 lands **before** D1.
2. **BLOCKER-for-D2 — evaluator exec posture is now a resolved contract, not an Open-Q.** `check.command`
   MUST run through the runtime admissibility / HITL / sandbox path, with an explicit `timeoutMs` and
   **current-tree (non-stale) execution each turn**, reusing ONLY the `regression-oracle.ts` *engine
   contract shape* (exec-port + verdictCodes + fail-open) — **never** the bench sandbox posture and
   **never** a privileged exec bypass. Nailed in D2 below; removed from Open-questions.
3. **REVISE — the shared semaphore is not wired yet.** D2's race guard assumes ticker + evaluator
   share one `ContinuationSemaphore`, but the ticker **news up its own instance** inside
   `goal-continuation-hook.ts`. Two independent single-permit semaphores serialize nothing against
   each other. **Fix = hoist to a shared injected owner** both hooks receive (D2 below).

Minor folds: the **"revise" transition** during approval is specified in D1; `formatGoal` gains
`status`/`updatedAt` threading in D3. MODE A = BUILD/default-OFF, MODE B = PARK/measure-first, abstain
= BUILD; efficacy stays measure-first (no unit-test efficacy claim).

---

## Motivation

Two competitors shipped goal-UX on top of a persistent objective:

- **Claude `ProposeGoal`** — a *model-initiated* tool that proposes a persistent completion goal
  framed as an **evaluator-verifiable `condition`** (≤500 chars, e.g. `"all tests in test/auth pass
  (bun test exits 0)"`), gated by an HITL approval dialog by default, with an `ask_user:false`
  shortcut *only* when the user stated the outcome verbatim. A *separate evaluator* re-checks the
  condition each turn; `/goal clear` aborts.
- **Codex thread-goal inline editor** — inline edit/revert of the composer goal, "Updated N min ago",
  a "Replace current goal?" guard, pause/resume, and a 6-state summary chip + token bar.

quanta **already has a strong goal system** (ADR-0394/0402, H17). The delta is narrow and must be
stated honestly: quanta's model can *already* set goals via `objective_set`, but (a) with no HITL
gate, (b) with completion decided by **model self-marking** (no independent evaluator), and (c) with
no inline edit/revert/updated-ago/replace-guard UX. This RFC closes exactly those three gaps and
nothing else — it does **not** reinvent the 6-state machine, the store, or the continuation ticker.

---

## Non-goals

- No new goal state machine. Reuse `ObjectiveStatus` (6 states) verbatim.
- No new persistence layer. Reuse the ADR-0394 `ObjectivePort` / `createObjectiveStore`.
- No autonomous-pursuit change. Auto-continuation stays gated by the *separate* `QUANTA_GOAL_ENFORCE`;
  proposing/approving a goal never by itself grants autonomous execution.
- No heuristic "goal quality" scoring, no threshold-based over-proposing throttle.
- No claim that an LLM-judge evaluator is *better* than today's self-marking — that is measure-first.

---

## Current state (file:line — what `objective/` already has)

**The model can already set goals (delta = it is not HITL-gated):**
- `src/tool/objective/index.ts:206` `objective_set` (+ `objective_update` L274, `objective_get`
  L310) expose the per-thread objective to the LLM. All three declare
  `hitlTier: () => "pre-approval-ok"` (L216/L286/L319) — **information-class, no approval dialog**.
  So a *model-facing goal-setting tool already exists*; the ProposeGoal delta is purely the HITL
  gate + the verifiable-condition framing, not "the model can now set goals".

**Completion is model self-judgment — there is NO independent evaluator:**
- `src/agent/objective/types.ts:104-110` — derivation rule: `completed` is auto-derived when all
  (≥1) `successCriteria[].met` are true. Who sets `met`? The **model**, via
  `objective_update markCriterion(met:true)` → `src/agent/objective/store.ts:362`. There is no
  re-check against real state.
- `src/agent/objective/pursuit-prompt.ts:24` `GOAL_PURSUIT_DISCIPLINE` *tells* the model
  "verify completion against the actual current state … do not rely on … a plausible final answer",
  but this is **self-discipline in a prompt, not enforcement**. No code re-evaluates the goal.
- Contrast: quanta *does* have execution oracles, but only in **bench grading**
  (`src/runner/batch/eval/regression-oracle.ts`, grader) — not in the runtime agent loop.

**No inline-edit UX; the chip is text+elapsed only:**
- `src/apps/cli/slash/goal-cmd.ts` — `/goal <text>` set, `/goal` show, `/goal clear` → paused
  (L50). No edit/revert/updated-ago/replace-guard.
- `src/apps/cli/status-pills.ts:177` `formatGoal` renders `🎯 <text> · <elapsed>` — **no 6-state
  summary label**, no token bar. The `updatedAt` timestamp exists on the objective
  (`types.ts:87`) but is not surfaced.

**HITL mechanism available for reuse:**
- `hitlTier(input)` is **per-input** (`src/tool/types.ts:750`). A tool can return `"always-confirm"`
  or `"pre-approval-ok"` depending on its arguments. `always-confirm` routes through the
  admissibility-gate → `onConfirm` → surface approval dialog (`src/agent/admissibility-gate.ts:16`,
  `src/agent/types.ts:183`). Operator overrides are an **escalate-only ratchet**
  (`src/agent/hitl-tier-registry.ts` header) — a tier can be forced UP, never silently DOWN.

**Gates already wired:**
- `QUANTA_OBJECTIVE_TOOLS` — wires the store + the three tools
  (`src/host/runtime/objective-store-wire.ts:29`).
- `QUANTA_GOAL_ENFORCE` — arms the idle continuation ticker
  (`src/apps/cli/goal-continuation-hook.ts:35`, `runtime-config.ts:224`).
- `QUANTA_OBJECTIVE_BUDGET_ENFORCE` — makes the derived `usage_limited`/`budget_limited` real.

**The two real deltas + one UX gap:**
- (a) a model-facing **ProposeGoal tool under HITL** (existing `objective_set` is `pre-approval-ok`);
- (b) an **evaluator-verifiable condition + a per-turn evaluator** (today = model self-marks `met`);
- (c) the inline **edit/revert/updated-ago/replace-guard** editor UX + full 6-state chip.

---

## Design

### D0 — close every objective mutation door, gated by `QUANTA_PROPOSE_GOAL`

**Why this exists (review BLOCKER):** the HITL gate on `propose_goal` is *voluntary* while an
equivalent **ungated** `objective_set` (`src/tool/objective/index.ts:207`, `hitlTier: () =>
"pre-approval-ok"` at `:216`) sits beside it writing the **same authoritative objective**
(`:240` → `port.set`) that the continuation ticker pursues (`continuation.ts:294`, setter-agnostic).
Without D0, a model wanting an autonomously-pursued goal simply calls `objective_set` and skips the
dialog — D1's entire HITL value is decorative.

**Mechanism:** install the R5 `ObjectiveMutationGatePort` around the authoritative ObjectivePort
mutations. Do not depend on the static name registry. The port receives bound thread identity and a
closed operation kind, can reuse the host `onConfirm` UI, and refuses mutation when confirmation
capability is unavailable. `objective_update` may therefore distinguish verifier completion from
model completion without escalating unrelated read/update operations.

- **OFF (`QUANTA_PROPOSE_GOAL` off):** no registry entry ⇒ `objective_set` stays `pre-approval-ok`,
  byte-identical to today.
- **ON:** every model-originated objective mutation is mediated at the store boundary; direct tool,
  alias, or future surface cannot bypass by choosing a sibling tool.
- **Red-on-injection test (pins the hole):** with `QUANTA_PROPOSE_GOAL` on, a scripted model call to
  `objective_set` MUST resolve to `always-confirm` / route through `onConfirm` (assert the resolved
  tier + gate invocation, not the output string). Without D0 this test fails, exposing the bypass.

D0 is an authority refactor, not a 0.25-day registry seed. Estimate after all mutation call sites
and surface capabilities are inventoried.

### D1 — `propose_goal` tool (model proposes → HITL → persist), gated `QUANTA_PROPOSE_GOAL`

New tool `src/tool/objective/propose-goal.ts`, wired through the *same* `ObjectivePort` as the
existing trio (composed in `src/agent/tier1/objective.ts` only when the new gate is on).

```
input:  { condition: string (min 1, max 500),
          check?: { kind:"command"; argv:string[]; timeoutMs:number;
                    successExitCodes:number[] } }
policy: ObjectiveMutationGatePort(operation:"set", actor:"model")
```

- **`ask_user:true` (default)** → `always-confirm` → `onConfirm` shows the full `condition`. On
  approve: `port.set(threadId, { goal: condition, successCriteria: [condition] })` +
  `updateStatus("active")`. On deny: no-op, `{ ok:false }`.
- **No shortcut.** Model-originated proposal always requires an admitted mutation receipt. A future
  user-originated command may be trusted only through its structural actor provenance.
- The condition is stored as the single `successCriterion` so it flows into the existing completion
  derivation (types.ts:104). `/goal clear` (existing) remains the human abort.
- **Revise during approval:** current confirmation supports allow/deny/deny-and-steer only. Revise is
  a deny followed by an explicit user-owned editor command; no fictional replacement variant and no
  recursive tool re-execution.

`propose_goal` is **additive** to `objective_set` in surface, but under `QUANTA_PROPOSE_GOAL` the
sibling `objective_set` is tier-escalated by **D0** — so it does not leave an ungated goal-setter.

### D2 — evaluator-verifiable condition + per-turn evaluator — PARK until prerequisites

The honest crux (R1/R2): "evaluator re-checks the condition" only has teeth if the check is
**executed**, not LLM-judged. Two modes, explicit fallback:

- **MODE A — execution oracle (genuinely enforceable; quanta EXTENSION beyond Claude).**
  If the persisted criterion carries the structured argv check defined by R5, the evaluator runs it
  and only `VerifierCompletionPort` may mark it met.
  The evaluator spawns `check.command` and compares exit code; pass ⇒ `markCriterion(met:true)` ⇒
  existing derivation auto-completes ⇒ existing continuation ticker stops.

  **Exec posture — resolved contract (review BLOCKER-for-D2, no longer an Open-Q):**
  `check.command` is a *live side-effecting exec* and MUST obey the runtime the model's own bash
  obeys. Non-negotiable, closed **before** any D2 code:
  - **Admissibility / HITL / sandbox:** the check routes through the same `admissibility-gate` →
    HITL/sandbox path as the model's own commands. The evaluator gets **no privileged exec bypass**;
    "임의 shell을 무제한 evaluator로 실행" is prohibited.
  - **Lifecycle timeout/cancel:** timeout covers permission wait, process execution, and result
    collection; session cancellation aborts every phase.
  - **Snapshot correctness:** capture source digest before execution and after execution. Commit only
    if objective revision and digest still match; otherwise abstain/retry. “Current tree at start” is
    not enough.
  - **Reuse only the engine *contract shape*, not the bench posture:** reuse `regression-oracle.ts`'s
    exec-port + `verdictCodes` + fail-open (`toRegressionGreen`) *shape* — `0 ⇒ pass`; verdict-codes
    gate "real verdict"; anything else ⇒ **abstain, never auto-complete** (heuristic-free). Do NOT
    reuse its bench *execution* posture (bench sandbox tree, injected bench exec port, PASS_TO_PASS
    provenance); drive the same contract through the **runtime bash/admissibility path** so approval
    + sandbox are inherited.
- **MODE B — LLM-judge (Claude parity; MEASURE-FIRST, default disabled).** No `check` present:
  a second LLM call judges "condition met?" from conversation state. This is **not stronger than
  today's self-marking** (an LLM judging an LLM). It stays behind its own sub-flag and is **not**
  claimed as efficacy until an A/B on SWE picks shows a real delta.
- **FALLBACK — unverifiable condition.** No `check` and MODE B off ⇒ the evaluator **abstains**:
  completion stays exactly as today (model self-marks `met`) plus a one-line
  `unverifiable condition (no runnable check)` note. **No silent auto-complete, no runaway.**

Wiring uses a **per-thread ObjectiveExecutionLease** shared with normal turn mutation boundaries,
not only the continuation ticker. Do not hold the lease while waiting for human approval. Execution
produces a candidate receipt; a short final lease validates revision+digest and performs CAS.

The existing global `ContinuationSemaphore` is insufficient: it serializes ticker callbacks, not
ordinary tool/file mutation, and a global permit can starve unrelated threads. D2 remains PARKED
until the keyed lease and CAS receipt are real.

### D3 — goal-editor UX (edit/revert/updated-ago/replace-guard + full chip), gated `QUANTA_GOAL_EDITOR`

- **6-state summary chip.** Reuse `ObjectiveStatus` → a `Record<ObjectiveStatus, string>` label map
  (drift-guarded; adding a state fails compile) rendered in `status-pills.ts`:
  `active`→"Pursuing goal", `completed`→"Goal achieved", `paused`→"Paused goal",
  `blocked`→"Goal stalled", `budget_limited`→"Goal limited", `usage_limited`→"Goal usage limited".
  (Codex `stalled` maps to quanta `blocked`; not a naming 1:1 but a state 1:1.) Add a token bar from
  `budget.tokensUsed/maxTokens` (only when a cap is set).
- **updated-ago.** Derive from the existing `objective.updatedAt` (types.ts:87) — "Updated N min ago"
  / "Updated just now".
- **projector wiring (review minor).** `formatGoal` today receives a pre-projected
  `{ text, elapsedMs }` (`status-pills.ts:177`); the 6-state chip + updated-ago need the **upstream
  projection site to also thread `status` + `updatedAt`** into `formatGoal`. This is a change at the
  projection site (a wider projected shape), **not** a store change — the ADR-0394 port stays closed.
- **revert (one durable revision).** Add an authority-owned `ObjectiveRevision` snapshot and
  `restore(snapshot, expectedRevision)` CAS port. It restores criterion ids/met/provenance, status,
  blockers, next actions, budget, and timestamps atomically. Surface-local undo is prohibited.
- **replace-guard.** `/goal <text>` while an active goal exists prints "Replace current goal? run
  `/goal replace <text>`" instead of silently overwriting. New `/goal edit`, `/goal revert`,
  `/goal pause`, `/goal resume` slash verbs on the existing framework; web/Tauri composer gets the
  inline dialog + Save/Cancel/Revert + pause/resume/clear controls with the verbatim Codex strings.
- Every edit/pause/resume/clear/restore includes `expectedRevision`; stale multi-surface edits fail
  with a refresh-required response instead of clobbering newer state.

---

## Default-OFF gate

Three independent, default-OFF gates; **all off ⇒ zero new tools, zero new hooks, zero new UI ⇒
`ToolRegistry` + agent loop byte-identical:**

| Gate | Effect when ON | OFF posture |
|---|---|---|
| `QUANTA_PROPOSE_GOAL` | installs D0 mutation gate and registers `propose_goal`; missing confirmation capability refuses activation | port absent; existing objective behavior byte-identical |
| `QUANTA_GOAL_EVALUATE` | only registered after all D2 prerequisites; checked criteria become verifier-only | no hook, no checked criterion schema exposed |
| `QUANTA_GOAL_EDITOR` | inline edit/revert/updated-ago/replace-guard + full 6-state chip | today's `🎯 text · elapsed` chip |

No model-controlled tier downgrade exists.

---

## TDD + hellgate

RED e2e first, then TDD, then 3R adversarial, then self-audit (repo protocol).

1. **RED e2e (real loop, scripted-LLM).** `runAgent` with a scripted model that calls
   `propose_goal` — assert the approval dialog fires (`onConfirm` invoked) and, on approve, the
   objective persists with `status:active` and the condition as its criterion. Prove the seam with
   `runAgent × scripted-LLM`, not a stubbed unit.
2. **Evaluator red-on-injection (MODE A, anti-vacuous; prerequisite rail while PARKED).** Real check: spawn
   `bun -e 'process.exit(0)'` ⇒ goal completes; **flip to `process.exit(1)` ⇒ goal must NOT
   complete** (criterion stays `met:false`, status stays `active`). A test that only asserts the
   happy path with an always-true check is rejected as vacuous.
3. **D0 all-door matrix.** Under the gate, exercise `objective_set`, replace, model
   `markCriterion`, pause/resume/clear, direct future alias, and missing-HITL surface. Assert the
   mutation authority sees bound thread id + operation and no effect precedes admission.
4. **Byte-identical hellgate.** All three gates OFF ⇒ tool list + loop transcript byte-identical to
   pre-RFC baseline (pins default-OFF).
5. **Enum drift guard.** The chip label `Record<ObjectiveStatus,string>` and the `propose_goal`
   status handling must fail compile if a 7th state is added (mirror the existing two-way guard in
   `src/tool/objective/index.ts:60`).
6. **Editor CAS round-trip.** edit → updated-ago recomputes; exact revision restore succeeds;
   concurrent stale edit/revert rejects without overwriting the winner.
7. **Verifier race rail.** mutate files or objective revision while check runs; stale result must
   abstain. Timeout during approval and session cancellation must release resources and never mark met.

---

## Effort

- D0 mutation authority + call-site inventory + capability matrix: **M**.
- D1 proposal/check persistence + approval receipts: **M**.
- D3 projection is S; durable revision/CAS editor across CLI/web is **M/L**.
- D2 evaluator is **unestimated/PARKED** until execution lease and verifier schema owners land;
  once admitted, expect at least M/L.
- Full product is no longer represented by the stale 5.75–6.5 day estimate.

---

## Risks + traps

- **Evaluator collapses to self-judgment.** MODE B *is* an LLM judging an LLM — no stronger than
  today. Guard: MODE B default-disabled + measure-first; MODE A is the only path claimed enforceable.
- **Unverifiable-condition runaway.** A condition with no runnable check that also never self-marks
  could keep the continuation ticker resuming forever. Guard: explicit abstain fallback (D2) — keep
  today's self-mark path + note; never silent-complete, never block-forever (budget cap still trips).
- **Mutation bypass:** any mutation path not routed through D0 is a release blocker. Static name
  registries and model booleans are not authority. `ask_user:false` is dropped.
- **Over-proposing.** Store is single-objective-per-thread (a new `set` replaces). So spam just
  churns; the replace-guard + "shortcut can't replace an active goal" caps the damage; no heuristic
  throttle needed.
- **Evaluator/turn race.** Idle-boundary scheduling is insufficient. Guard: source digest +
  objective revision CAS under a per-thread execution lease.
- **Vacuous tests.** Every evaluator test must red-on-injection with a real (spawned) check.

---

## Sequencing

0. Inventory all ObjectivePort mutation call sites and freeze the all-door RED matrix.
1. Build D0 mutation authority + bound thread identity + fail-closed capability contract.
2. Extend criterion/revision schema and migrations; build D1 without shortcuts.
3. Land read-only D3 projection, then CAS editor/restore through protocol authority.
4. Build per-thread execution lease + verifier completion port + digest/CAS rails; only then un-park D2.
5. Measure-first A/B on SWE picks: does MODE A completion change land-rate vs self-marking? Only then
   consider MODE B / any default-ON.

---

## Open questions

- ~~Should `check.command` reuse the bench `regression-oracle` execution posture, or the runtime
  bash-tool path?~~ **RESOLVED (review):** reuse only the `regression-oracle.ts` *engine contract
  shape*; drive it through the runtime admissibility/HITL/sandbox path with `timeoutMs` + current-tree
  exec; never the bench posture, never a privileged bypass. See D2.
- Condition ≤500 (Claude) vs quanta's existing goal cap 4000/8000. Keep 500 for the *proposed*
  condition (dialog-readability), 4000 for `/goal` free-form?
- Web/Tauri revert authority: **RESOLVED by R5** — one durable authority-owned revision + CAS;
  surface-local undo is prohibited.

---

## Audit log R1 → R3

### R1 — structural / "is it already built?"
- **Claim tested:** "ProposeGoal lets the model set goals — quanta lacks this." **REFUTED.**
  `objective_set` (`src/tool/objective/index.ts:206`) already lets the model set goals. The real
  delta is narrower: the HITL gate + the verifiable-condition framing. RFC corrected to say so.
- **Claim tested:** "a separate evaluator re-checks the condition (Claude parity)." **Sharpened.**
  quanta completion today is model self-marking `markCriterion` (store.ts:362) — genuinely no
  evaluator. BUT Claude's own evaluator "judges the condition met *from the conversation*" = an
  LLM-judge, **not execution**. So MODE B is mere parity (LLM judging LLM); the *enforceable* value
  is MODE A (execution oracle), which is an **extension beyond Claude**, not "what Claude does".
  RFC must not sell MODE A as parity nor MODE B as strength. **Corrected.**
- **Flag raised (→R3):** `ask_user:false` trusts the model's self-attestation of "verbatim". Real
  bypass surface. Deferred to R3 for mitigation.

### R2 — measure-first / vacuity
- **Attack:** "verifiable condition" collapses to self-judgment. **Confirmed partial.** MODE B fully
  collapses. MODE A only enforces when the condition carries a parseable `check`; most free-form
  conditions carry none. If the evaluator silently self-marks on a no-check condition, the whole
  feature is vacuous (a fancy relabel of today). **Fix:** explicit *abstain* fallback (D2) — no
  check + MODE B off ⇒ evaluator does nothing, completion stays today's self-mark + a visible
  "unverifiable" note. The enforceable claim is scoped to MODE A only.
- **Attack:** an evaluator test that asserts "goal completes" with an always-true stub proves
  nothing. **Fix:** hellgate #2 requires a *real spawned* check and **red-on-injection** (exit 1 ⇒
  must not complete). Efficacy itself is measure-first: A/B on SWE picks before any default-ON;
  expectation is net-zero, so it ships default-OFF.

### R3 — adversarial hardening
- **HITL bypass (from R1):** model spams `propose_goal(ask_user:false)` to self-authorize.
  **Mitigations landed in D1/gate:** (1) shortcut refused when it would replace an active goal —
  the verbatim shortcut only applies to first-set or exact re-affirm; (2) mandatory transcript
  notice even on the shortcut; (3) operator escalate-only ratchet can pin `always-confirm`;
  (4) decisive: a *set* goal is **inert** — autonomous pursuit needs the *separate*
  `QUANTA_GOAL_ENFORCE`, so skipping the dialog never buys execution.
- **Over-proposing:** single-objective-per-thread store means spam only churns; replace-guard +
  active-goal-shortcut-refusal cap it. No heuristic throttle (honors no-heuristics rule).
- **Self-planted defect caught:** my first D2 draft had the evaluator marking `met` "each turn"
  concurrently with the continuation ticker — the evaluator could complete a goal the model is still
  actively working, truncating a turn. **Fixed:** evaluator runs at the idle boundary through the
  *same* `ContinuationSemaphore` (continuation.ts), serialized, never concurrent.
- **Default-OFF proof:** all three gates off ⇒ no tool, no hook, no UI ⇒ byte-identical (hellgate
  #4). Confirmed no shared-hot-path mutation leaks when off (the propose tool is composed only under
  its gate in `tier1/objective.ts`; the chip map only renders under `QUANTA_GOAL_EDITOR`).
- **Residual open risk (R3, now CLOSED by review-fold):** MODE A's `check` execution path shares
  HITL/sandbox with model commands — could become a sandbox-escape (run arbitrary `check.command`
  outside approval). R3 flagged it as an Open-Q, not yet closed. **Review-fold RESOLVES it:** D2 now
  carries a resolved exec-posture contract (admissibility-routed + `timeoutMs` + current-tree, reuse
  only the `regression-oracle.ts` contract shape) as a hard D2 prerequisite. See "리뷰 반영" §2 + D2.
- **R4 (review) — sibling-door bypass, was the dominant hole:** R3's bypass mitigations only covered
  `propose_goal`'s internals; the ungated `objective_set` sibling defeated the gate at the system
  level. **Closed by D0** (escalate `objective_set` under the propose gate) + red test 3b. See
  "리뷰 반영" §1.
- **R4 (review) — shared-semaphore wiring:** the ticker news up its own `ContinuationSemaphore`, so
  D2's race guard was inert. **Closed by the D2 shared-semaphore hoist** (inject one instance into
  both hooks). See "리뷰 반영" §3 + D2.
