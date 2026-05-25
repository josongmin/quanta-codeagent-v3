# ADR-0255: Cross-subagent todo readback (Roo bidirectional extension)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0219 (Focus Chain — parent→child auto-reinject;
  this slice is the BIDIRECTIONAL counterpart)
- **References**:
  `src/agent/todo-readback/{port,types,default-store,index}.ts`,
  `tests/unit/agent/todo-readback-hellgate.test.ts`

## Research grounding

Per Roo's published runtime: a child subagent does not just consume the
parent todo block — it can also write back into the parent's todo list
when its own progress changes. The parent then observes the update on
its next prompt assembly. ADR-0219 only models the parent→child leg
(auto-reinject every N turns). Without the readback leg, a long
subagent run finishes invisibly: the parent's todo block goes stale
because nothing flowed upward. Roo plugs this gap.

Single-vendor signal (Roo). We absorb it because: (a) the parent's
attention-window mechanics that motivated ADR-0219 apply to subagent
runs too; (b) it composes additively with ADR-0219 — same shape, new
direction; (c) the implementation is small and default-OFF — when
unwired the loop is byte-identical.

## Context

ADR-0219 splices the parent's todo list back into the parent prompt
every N turns (parent→child of the same session is conceptually a
single conversation; "child" there meant "later turn"). The gap:
multi-session work where a subagent owns a slice of the parent's
plan. Today there is no port for the subagent to say "todo #3 is now
in-progress" without serialising its own session log and asking the
operator to reconcile.

Two concerns must be separated:

1. **Readback** — any session can snapshot another session's todo list
   (typically the parent reading a child's progress or a child reading
   the parent's plan to know which item is owned).
2. **Propagation** — a child session can write an update that, when
   the host explicitly calls `propagate(child, parent)`, lands in the
   parent's todo list. Propagation is NEVER automatic — the host
   decides when to merge, mirroring the close-out / commit boundary.

Combined, they make a multi-session run self-coordinating: the child
updates its own todos as it works, and at safe seams (turn boundary,
subagent close-out) the host propagates upward so the parent's next
ADR-0219 injection reflects real child progress.

## Decision

Add a closed-port slice `src/agent/todo-readback/` with three
responsibilities:

- **`TodoReadback`** — `snapshotFor(sessionId)`, `updateFrom(sessionId,
  partial)`, `subscribe(sessionId, cb, opts?)`, `propagate(childSessionId,
  parentSessionId)`, `link(parent, child)`. Result-returning where
  failure is expected (`updateFrom` on unknown session ⇒
  `Err("session-not-found")`); NO-THROW on every other public method.
- **`TodoSnapshot`** — frozen `{ items: readonly TodoItem[], updatedAt:
  number }`. Items: `{ id, text, status: "pending"|"in_progress"|
  "completed" }`. NOTE: status arm uses underscore (`in_progress`) —
  matches the Roo wire format. ADR-0219's `FocusTodo` uses hyphen
  (`in-progress`) — the slices are siblings, not the same type; the
  host maps at the wiring site if it wants to feed one into the other.
- **`defaultTodoReadbackStore(opts?)`** — Map-backed per-session state
  + explicit parent-child linkage map. Subscriptions fire on every
  `updateFrom` (including the propagation leg).

### Invariants

1. **NO-THROW** on every method. The store is observability-grade
   infra. Recoverable failures (unknown session) surface as
   `Result.err` so the host can branch.
2. **Default-OFF** — no slice in the agent loop constructs a store;
   the host wires it explicitly. Absent wire ⇒ byte-identical loop.
3. **PARENT ISOLATION** — a child's `updateFrom` does NOT auto-mirror
   into the parent. The host must call `propagate(childSid,
   parentSid)` to merge. This prevents read-during-write races and
   matches our close-out / commit posture.
4. **EXACT-OPTIONAL** — `exactOptionalPropertyTypes` posture: optional
   fields are OMITTED, never `undefined`-set.
5. **PURE STATE** — in-memory only. No persistence (Phase 2 if
   needed; ADR-0145 / ADR-0130 voice).
6. **FROZEN SNAPSHOTS** — `snapshotFor` returns a frozen view; the
   caller cannot mutate the store via the returned reference.
7. **MONOTONIC `updatedAt`** — every successful update strictly
   increases the snapshot's `updatedAt` (clock injection in tests;
   monotonic counter under concurrent writes).
8. **LAST-WRITE-WINS by `updatedAt`** — under concurrent
   `updateFrom`, the chronologically last call (by injected clock)
   becomes the visible state. Deterministic ordering at equal
   timestamps: the explicit call order.
9. **SUBSCRIBE-WITH-SNAPSHOT** — `subscribe(sid, cb, { snapshot:
   true })` synchronously delivers the current snapshot before
   returning, then continues normally.

## Why this is distinct from ADR-0219 (Focus Chain)

| Axis              | ADR-0219 (Focus Chain)         | ADR-0255 (Readback)            |
|-------------------|--------------------------------|--------------------------------|
| Direction         | one-way (auto-reinject)        | bidirectional (read + write)   |
| Scope             | single session                 | cross-session (parent / child) |
| State key         | implicit (the tracker IS the session) | explicit `sessionId`     |
| Status enum       | `pending\|in-progress\|done`   | `pending\|in_progress\|completed` |
| Propagation       | n/a                            | explicit, host-driven          |
| Trigger           | every Nth turn (auto)          | every `updateFrom` (event)     |

They are COMPLEMENTARY, not redundant. ADR-0219 stops a single
session from forgetting its plan; ADR-0255 stops a parent + child
pair from drifting apart.

## Default-OFF posture

No slice in the agent loop constructs a store. The host wires it via
a future `AgentConfig` slot (out of scope for this slice). Until
wired, every callsite that would use the readback path is absent and
the loop is byte-identical.

## Slice isolation

- Pure types + a factory + the Result type from `@/shared`.
- No `@/agent/loop` / `@/agent/dispatch` / `@/agent/focus-chain` /
  `@/llm` / `@/tool` imports. The slice does NOT import its sibling
  ADR-0219 — the host is responsible for any bridging.
- Output is plain typed data; the host decides which surface
  (prompt block, system-reminder, IPC event) renders it.

## Validation

- **Hellgate**: `tests/unit/agent/todo-readback-hellgate.test.ts` —
  15 cases covering snapshot shape / update happy + sad path /
  subscribe-then-update / unsubscribe / parent isolation / explicit
  propagation / status 3-arm exhaustive / frozen snapshot / 1000-todo
  perf sanity / default-OFF byte-identical / updatedAt monotonic /
  concurrent last-write-wins / subscribe-with-snapshot / abort-signal
  cleanup.
- **TSC**: 0 errors introduced by this slice.
- **Biome**: 0 errors on this slice.

## Limits + follow-ups

- Persistence: store state is lost on process restart. Phase 2 could
  add a `serialize/hydrate` pair (ADR-0145 voice). Out of scope here.
- Merge policy: `propagate` is currently overwrite-by-id (child item
  with id X replaces parent item with id X; unknown ids are inserted
  at the end). Smarter merge (3-way, conflict markers) is Phase 2.
- Tool registration: same as ADR-0219, the host wires the store
  through `AgentConfig` and decides whether to surface
  `update_todo` / `read_todos` as tools.
- ADR-0219 bridging: a future helper could feed `snapshotFor(self)`
  into `FocusChainPort.setTodos` so the parent's auto-reinject sees
  the propagated child state. Intentionally NOT bundled here — the
  status enums differ on purpose and the host maps at the wiring
  site.
