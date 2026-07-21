# ADR-0394 — Objective as a first-class per-thread object

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/objective/` (new, self-contained) + hellgate.
**Wave scope:** MODEL ONLY — the typed model, the closed port, and the
in-memory store. NOT wired into the agent loop, dispatch, prompt, features,
or any tool. This is the substrate later waves attribute to.
**Default-OFF:** Yes — importing the barrel allocates nothing and mutates no
process state until a host calls `createObjectiveStore()`. No existing code
path references the slice, so the agent is byte-identical to the pre-ADR-0394
build.

## Context

The biggest structural gap in quanta is that there is no first-class
"objective" tying a thread's work together. The goal, what "done" means, what
is currently blocking progress, what to do next, and the budget the work runs
against are all implicit — inferred (re-derived every turn) from message
scrollback by compaction, resume, subagent-result attribution, and approval
flows. There is no single typed object any of those can read or write.

Every competitor that gets long-horizon work right (Codex follow-up queue +
turn_context, Cursor focus-chain todo reinjection, Claude objective/plan
panes) keeps an explicit, mutable objective. quanta keeps none. Compaction in
particular has nothing durable to preserve across a summarize — it discards
scrollback and hopes the summary captured intent.

## Decision

Introduce a pure new slice `src/agent/objective/` exposing one closed port,
`ObjectivePort`, and one zero-dep in-memory implementation,
`createObjectiveStore`. The `Objective` is owned by exactly one `threadId`.

### Model

- `Objective` — `{ threadId, goal, successCriteria[], status, budget,
  blockers[], nextActions[], createdAt, updatedAt }`, all `readonly`.
- `SuccessCriterion` — `{ id, text, met }`. Individually checkable; `id` is a
  `crypto.randomUUID()`.
- `Blocker` — `{ id, reason, waitingOn, since }`. `waitingOn` is a closed enum
  `"user" | "tool" | "network" | "child_agent"`; `since` is epoch-ms.
- `ObjectiveBudget` — `{ maxTokens?, tokensUsed, maxTurns?, turnsUsed }`. The
  `max*` caps are optional (omitted when absent); the `*Used` totals are
  always present and monotonically non-decreasing.
- `ObjectiveStatus` — `"active" | "blocked" | "completed"`.
- `ObjectiveSnapshot` — `{ objectives[] }`, a serializable point-in-time view.

### Status derivation rule (the load-bearing invariant)

`status` is NEVER the source of truth on its own. The store persists the
caller's last EXPLICIT intent (`"active"` | `"completed"`) separately and
DERIVES the public `status` on every read and write:

1. `blockers.length > 0`        ⇒ `status = "blocked"`  (highest priority)
2. else all criteria met (≥ 1)  ⇒ `status = "completed"`  (auto-derived)
3. else                          ⇒ the last explicit `updateStatus` value,
   defaulting to `"active"`.

Consequences, all pinned in `tests/unit/objective-hellgate.test.ts`:

- `updateStatus("active" | "completed")` is honored ONLY while not blocked; a
  non-empty blocker list always wins. `updateStatus("blocked")` is a no-op —
  "blocked" is derived exclusively from the blocker list, never set directly.
- Auto-completion requires at least one criterion. A zero-criteria objective
  is never "completed" by derivation (vacuous truth is rejected — an empty
  objective is not "done").
- Adding a blocker to a fully-met objective SUPPRESSES completion; clearing
  the last blocker re-derives "completed".

### Port semantics

- **NO-THROW**: every method wraps its body and degrades to `null` (mutators
  and `get` on unknown / malformed input) or an empty result (`list`,
  `toSnapshot`). No method throws. `set` is signature-non-null, so on
  malformed input it returns a synthetic empty `Objective` rather than `null`.
- **Unknown `threadId`** ⇒ `null` on `get` and on every mutator.
- **Frozen snapshots**: every returned `Objective` (and its nested arrays /
  records) is `Object.freeze`d, so a caller cannot mutate the store through a
  returned reference.
- **Clock seam**: `createObjectiveStore({ now })` injects the clock (default
  `Date.now`) so timestamps are deterministic in tests. `createdAt` is sticky;
  `updatedAt` advances on every successful mutation.
- **Accumulation**: `recordUsage` adds non-negative finite integer deltas to
  `tokensUsed` / `turnsUsed`; negative / `NaN` / non-finite deltas are clamped
  to a no-op (usage never decrements).
- **Snapshot round-trip**: `toSnapshot()` → `fromSnapshot()` reproduces an
  identical store (deep-equal, JSON byte-stable). `fromSnapshot` REPLACES all
  prior state (it does not merge) and tolerates a hostile / malformed snapshot
  without throwing (junk entries are dropped).

### Slice fence

No imports from `@/agent` core (loop / dispatch / prompt / features / types),
`@/apps`, or sibling slices. The only dependency is `node:crypto` for
`randomUUID`. The barrel `src/agent/objective/index.ts` is the only allowed
import path.

## Alternatives considered

- **Reuse the former `Stage1StorePortV2` (ADR-0216) shape** — rejected: that port was a
  Promise-returning `{ ok, value } | { ok:false, code }` discriminated result
  for a SQLite-backed memory record. The objective model is synchronous,
  in-process, and uses a null-degrade contract; conflating them would couple
  two unrelated lifecycles.
- **Store `status` as a plain mutable field** — rejected: it would let
  blocked/completed drift out of sync with the blocker list and criteria
  (e.g. a "completed" objective that still has an open blocker). Deriving the
  status on read makes the invariant impossible to violate by field drift.
- **Wire into the loop now** — explicitly out of scope. There is in-flight
  work on the shared agent files; this wave ships the substrate only.

## Consequences

- A later wave can wire `createObjectiveStore` into the composition root and
  have compaction preserve `{ goal, successCriteria, nextActions, blockers }`
  verbatim across a summarize, resume re-hydrate from `fromSnapshot`, and
  subagent results attribute to the parent's objective.
- Default-OFF + zero cross-slice imports means the slice carries no regression
  surface until it is deliberately wired.
