# ADR-0259: Plan-writeback — bidirectional skill ↔ plan sync

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0203 (user-authored playbook frontmatter — `procedure` +
  `success-criteria` declarative shapes a skill carries), ADR-0218 (subagent
  mode-typed delegation — single-shot result envelope, this slice's writeback
  is a complementary "discovery during execution" channel ADR-0218 deliberately
  left out)
- **References**:
  `src/skill/playbook/plan-writeback/{port,types,default-writeback,index}.ts`,
  `tests/unit/skill/playbook/plan-writeback-hellgate.test.ts`

## Research grounding

Devin's playbook runner is **bidirectional**: a playbook step that uncovers a
blocker, opportunity, or scope discovery during execution can *record a finding
against the active plan*, so that when the planner re-renders the plan (next
turn, next prompt cycle, or a user-initiated review) the discovery surfaces
as a delta. Empirically observed in the public Devin product copy: "as Devin
runs the playbook it logs findings against the plan; the plan updates without
re-prompting the user".

quanta today is **uni-directional** — `plan → tool dispatch`. ADR-0203 gives a
skill a declarative `success-criteria[]` + `procedure[]`, but there is no
in-process surface for a running skill to **emit a finding back to the
plan**. Skills can write to memory (ADR-0021), but memory is owned by the
agent loop's compaction policy — not by a plan re-render cycle. The result is
that mid-playbook discoveries are either (a) lost when the turn ends, or (b)
narrated into the assistant's final message (best-effort, no structure).

The 5-vendor convergence on this shape:

- **Devin Playbooks** — findings recorded against the active plan, surfaced on
  next plan render.
- **Cursor agent mode** — `update_plan` tool that mutates plan tasks mid-turn.
- **Roo orchestrator** — chunk-level `progress` events carry sub-task findings
  to the parent orchestrator.
- **Claude Code TodoWrite** — sub-tasks gain/lose items as the agent
  discovers scope.
- **Codex `agent_message_delta`** — interleaves discovery narration with the
  primary result.

Each vendor lands on the same shape: a typed **PlanUpdate** carrier — `{ planId,
skillId, finding, recordedAt }` — that the host consumes on a re-render
boundary. This ADR absorbs that shape as a closed-port slice, **without**
mutating any existing plan object.

## Context

ADR-0203 gives us *what a playbook declares*. ADR-0218 gives us *what a
delegated mode returns*. Neither covers the **in-flight discovery surface**.
Two operational gaps:

1. **Finding loss** — a playbook step that finds "this success-criterion is
   actually unreachable because dependency X is missing" has nowhere typed to
   put that fact. It either becomes prose in the final assistant message or
   it dies with the turn.
2. **No re-render delta** — even if the planner re-renders next turn, there
   is no structured queue of "what changed since the last render". The
   planner has to re-derive deltas from raw memory.

The closed-port + default-OFF posture is preserved — the loop never
constructs a `PlanWriteback`; callers (apps / tier1 builders / a future plan
renderer) opt in by injecting one. When no `PlanWriteback` is wired the
ADR-0203 playbook path is byte-identical to before this slice landed.

## Decision

Add a closed-port slice `src/skill/playbook/plan-writeback/` that closes both
gaps without modifying ADR-0203 or ADR-0218:

- **`PlanWriteback`** (`port.ts`) — three small methods:
  - `recordFinding(skillId, finding): Result<PlanUpdate, WritebackError>` —
    accept a typed finding against the active plan (id supplied at writeback
    construction); returns the recorded `PlanUpdate` envelope or a typed
    operational error.
  - `getUpdates(planId): readonly PlanUpdate[]` — read the recorded updates
    for a given plan id. Return value is frozen — caller cannot mutate.
  - `clearUpdates(planId): void` — drain after the host has consumed (e.g.
    after re-rendering the plan for the next prompt cycle).
- **`Finding`** (`types.ts`) — closed 3-arm shape:
  - `kind: "discovery" | "blocker" | "opportunity"`
  - `text: string` (non-empty; trimmed empty → `WritebackError("empty-text")`)
  - `severity: "info" | "warn" | "critical"`
- **`PlanUpdate`** (`types.ts`) — envelope:
  - `{ planId, skillId, finding, recordedAt }` (recordedAt = epoch ms,
    monotonic per writeback instance via internal counter, NOT wall clock —
    HELL-PW-09).
- **`WritebackError`** (`types.ts`) — closed 3-arm union:
  - `{ kind: "plan-not-found" }`
  - `{ kind: "empty-text" }`
  - `{ kind: "skill-id-empty" }`
- **`defaultWriteback`** (`default-writeback.ts`) — Map-backed
  `planId → PlanUpdate[]`. Construction binds a single active `planId`; any
  `recordFinding` for a mismatching planId is rejected as `plan-not-found`.
  The implementation:
  - Never throws operationally — every failure is a typed `WritebackError`.
  - Stores nothing globally; one writeback instance = one Map = one active plan.
  - Returns frozen arrays + frozen `PlanUpdate` objects (HELL-PW-11,
    HELL-PW-15) so callers cannot accidentally mutate consumer state.
  - `recordedAt` uses an internal monotonically-incrementing counter seeded
    at instance construction, NOT `Date.now()` — so two `recordFinding`
    calls in the same millisecond still order-stable.

## Contracts (HARD)

1. **NO-THROW** — `recordFinding` / `getUpdates` / `clearUpdates` never throw
   for operational failure (HELL-PW-04, HELL-PW-07).
2. **Plan-not-found typed** — recording a finding for an unknown planId
   returns `Err("plan-not-found")` — NOT a throw, NOT a silent drop
   (HELL-PW-04).
3. **No plan mutation** — writeback NEVER mutates plan objects. It is a
   side queue the caller drains on its own re-render boundary. Tests pin
   this by writing 1000 findings and asserting plan body unchanged.
4. **Frozen returns** — `getUpdates` returns `Object.freeze`-d arrays of
   `Object.freeze`-d `PlanUpdate` (HELL-PW-11, HELL-PW-15).
5. **Default-OFF byte-identical** — when the host does NOT inject a
   `PlanWriteback`, the ADR-0203 path is byte-identical to before this
   slice landed. NO loop touches, NO ADR-0203 module touched
   (HELL-PW-08).
6. **Multi-plan isolation** — a single writeback instance carries ONE
   active planId; `getUpdates(otherPlanId)` returns empty (HELL-PW-12).
   Multiple plans = multiple writeback instances.
7. **Monotonic recordedAt** — within one writeback instance, recordedAt
   values are strictly increasing (HELL-PW-09, HELL-PW-13).

## Hellgate (15 cases)

`tests/unit/skill/playbook/plan-writeback-hellgate.test.ts` — see the
exhaustive list at the top of that file. Each test seals exactly one
invariant. The file uses pure fakes only (no live LLM, no I/O).

- HELL-PW-01 recordFinding returns PlanUpdate
- HELL-PW-02 getUpdates returns recorded entries in order
- HELL-PW-03 clearUpdates drains to empty
- HELL-PW-04 unknown planId → `Err("plan-not-found")`
- HELL-PW-05 Finding.kind 3-arm exhaustive (discovery/blocker/opportunity)
- HELL-PW-06 Finding.severity 3-arm exhaustive (info/warn/critical)
- HELL-PW-07 empty / whitespace-only text → `Err("empty-text")`
- HELL-PW-08 default-OFF: no writeback injection ⇒ byte-identical (slice
  not imported from outside its directory)
- HELL-PW-09 recordedAt monotonic across rapid calls
- HELL-PW-10 1000-finding performance sanity (under 200ms wall)
- HELL-PW-11 getUpdates returns frozen array (Object.isFrozen)
- HELL-PW-12 multi-plan isolation (different planId leaks nothing)
- HELL-PW-13 concurrent recordFinding order-preserved via recordedAt
- HELL-PW-14 WritebackError 3-arm closed exhaustive switch covers all
- HELL-PW-15 PlanUpdate frozen — mutation attempt fails (strict mode throw)

## Non-goals

- **No plan re-render policy** — this slice supplies the queue; *when* the
  host re-renders the plan is host-owned (could be next turn boundary, could
  be user-initiated, could be a streaming surface). The slice has no clock,
  no scheduler, no auto-flush.
- **No persistence** — `PlanWriteback` is in-memory. Persisting findings
  across sessions is a separate slice (memory + session-store collaboration);
  out of scope.
- **No auto-construction in the loop** — same default-OFF discipline as
  ADR-0203 / ADR-0218. The loop never builds a writeback; callers wire one
  through their own composition root if they want the bidirectional channel.
- **No multi-plan-per-instance** — one writeback instance binds to ONE
  active planId. Callers with N parallel plans construct N writebacks.

## Consequences

- Closed-port slice; zero touch in `src/agent/loop.ts`, ADR-0218 router, or
  any ADR-0203 module. Existing tests remain green by construction.
- The writeback surface is opt-in — when injected, the host's plan renderer
  consumes `getUpdates` + `clearUpdates` on its own cadence.
- Discovery determinism: the monotonic internal counter (NOT wall clock)
  means tests can pin order without injecting a fake clock — counter is
  purely instance-local.
