# ADR-0298 — Subagent Fanout Parallelization (Cursor `is_parallel_worker`)

## Status

Accepted (always-ON — the safety argument is structural, not a feature toggle).

## Context

Cursor 3.2's agent emits N `task` tool calls in a single assistant message
when it wants to fan out independent exploration workers, with each call
carrying `is_parallel_worker:true`. The runtime schedules every call into a
separate Run stream; results come back as the workers complete, ordered by
model-call position. This pattern is the standard SOTA shape for "explore
five things in parallel" tasks — the alternative (sequential `agent` calls
one per turn) wastes turns and wall-clock for genuinely independent work.

quanta has the streaming-dispatch infrastructure to do exactly this. The
engine at `src/agent/streaming-dispatch.ts` (the same one the agent loop
uses for every turn) already schedules concurrency-safe sibling tool calls
in flight, with a head-of-line barrier on the FIRST unsafe call. It
correctly preserves model-call order in the assembled `resultBlocks` via
`Promise.allSettled` keyed by slot index. We just weren't using it for
`agent`.

### Current behaviour

`src/subagent/agent-tool.ts` declared:

```ts
isConcurrencySafe: () => false  // before
```

with the stated rationale "Spawning a child agent has unbounded side effects
via its own tools; never batch concurrently with sibling calls."

This is **over-conservative**. The child's effects are bounded by the
child's own dispatch loop, not the parent's. The parent dispatch seam — the
thing `isConcurrencySafe` actually gates — only races on **parent-loop
mutable state**. Two sibling `agent` calls in the same parent turn share:

- **No** registry mutable state — `TaskRegistry.register()` mints a fresh
  `AbortController` + `owner_token` per call (verified by reading
  `src/subagent/registry.ts`).
- **No** working memory / conversation envelope — each child runs its own
  agent loop with its own `WorkingMemory`.
- **No** task-id space conflict — `mintTaskId` calls
  `registry.newId()` (background) or `crypto.randomUUID()` (foreground)
  per call.
- **No** checkpoint-path collision — each path embeds the per-call task id.
- **No** permission-tier dependency — `inferToolTier` runs per call BEFORE
  dispatch; siblings do not share a HITL decision.

The child's writes happen serially **within that child's loop** — they are
not in the parent's dispatch barrier scope. The previous classification
forced a head-of-line barrier whenever the model wanted to fan out 3-5
read-only explorers, defeating the streaming-dispatch overlap optimization
exactly when it would help most.

## Decision

### Flip `isConcurrencySafe`

`agent.isConcurrencySafe: () => true`. The previous comment is replaced
with a positive safety argument enumerating the four "no shared mutable
state" invariants above. `isReadOnly` remains `() => false` — the spawn IS
a side-effecting call (it commits a registry row, kicks off a child loop)
even when the child itself only reads; that classification is consumed by
plan-mode dispatch guards and must not change.

### Add declarative `parallel_worker?: boolean`

A schema field with **zero functional meaning**. The flag is for human +
telemetry observability — when present and `true`, downstream consumers
(future telemetry grouping, HITL audit logs, `agent_role` enums) can
recognize "the LLM intentionally chose to fan out these N calls" without
inferring it from event timing. The flag is NOT threaded into
`SubagentRequest` (a child contract field); it stays on the parent-side
tool input only.

This mirrors Cursor's `is_parallel_worker:true` declarative pattern. The
explicit declaration aligns with our `no-heuristics-only-validated` rule:
we do not infer parallel intent from event-timing heuristics; the model
declares it.

### System prompt advertisement

`src/agent/prompt-body.ts` "Tool routing" section gains one entry below the
existing "parallel independent reads → batch tool calls" guidance:

```
- Need to fan out independent
  exploration subagents              → emit multiple `agent` calls in one
                                       assistant message with
                                       `parallel_worker:true` (ADR-0298).
                                       They dispatch concurrently via the
                                       streaming-dispatch barrier; results
                                       come back in model-call order.
```

## Mechanism — How Streaming-Dispatch Already Solved This

`src/agent/streaming-dispatch.ts::scheduleResolvedCall` (line 254):

1. When a `tool_use_end` event resolves a call, the engine asks
   `isConcurrencySafe(name, input)`.
2. If safe **and** no head-of-line barrier is engaged yet this turn, it
   starts `dispatch(call)` immediately — in flight, NOT awaited — so the
   dispatch overlaps the remaining stream events.
3. If unsafe, it engages the barrier. Every later call (safe or not) is
   deferred to a post-stream serial drain.

By flipping `agent` to safe, the engine now starts a child spawn the
instant its `tool_use` block finishes streaming. With N `agent` blocks in
one assistant message, all N start while the model is still emitting
later text. Phase 4 (`collectResultBlocks`) collects results in model-call
order via `Promise.allSettled` keyed by slot index — completion timing
does not affect final ordering.

### What this does NOT change

- **The barrier still works.** A `write` or `bash` sibling in the same
  turn engages the HOL barrier; agents AFTER it are deferred to the serial
  drain, NOT executed concurrently with the side-effecting call. Sealed
  by `subagent-fanout-hellgate.test.ts → write FIRST then 2 agents` case.
- **Permission gates still run.** `inferToolTier` is called per dispatch
  inside the loop's `dispatch` binding (`src/agent/loop.ts`); it runs
  before each child spawn regardless of how the call was scheduled.
- **Depth + budget guards survive.** `ctxDepth(ctx) + 1` is read per call
  from the parent's `ToolContext`; sibling spawns at parent depth 1 all
  become depth 2. The `maxDepth` ceiling fires per call (sealed by the
  `maxDepth guard fires per call` hellgate case).
- **Background task IDs do not collide.** Each call mints a unique id via
  `registry.newId()`; sealed by the `each spawn gets its OWN task_id`
  hellgate case.
- **Each child's signal is independent.** Cancelling task A does not abort
  sibling task B; sealed by the `each child gets its own abort signal`
  hellgate case.

## Consequences

### Positive

- 3-5× wall-clock speedup for fan-out exploration patterns
  ("inspect these 5 files in parallel", "check these 3 hypotheses in
  parallel") — sealed by the `3 × 50ms concurrent < 3 × 50ms serial`
  hellgate case.
- One-message multi-spawn becomes the natural shape; the model no longer
  has to spend N turns to launch N independent reads.
- The streaming-dispatch optimization that was already in production for
  `read` / `grep` / `glob` finally extends to its highest-value tool.

### Negative / Risks

- The model may over-fan-out (5 spawns when 1 would do). Mitigation: the
  `parallel_worker` flag is opt-in; the system-prompt guidance specifies
  "independent exploration tasks", and the per-call depth + budget guards
  bound the worst case. The `inferToolTier` permission gate runs per
  spawn so HITL still applies.
- Telemetry that previously assumed agent calls are serial may need to
  handle interleaving. Mitigation: `onToolStart` fires per call in
  model-call order (sealed by hellgate); the existing telemetry hook
  shape is preserved.

### Negative invariants (NOT changed by this ADR)

- `agent.isReadOnly()` stays `false` — spawning a child IS a side effect
  even when the child reads only.
- Plan-mode dispatch guards are NOT bypassed — `inferToolTier` reads
  `isReadOnly`, not `isConcurrencySafe`.
- The barrier still engages on the FIRST unsafe sibling; we did NOT
  weaken the HOL invariant.

## Validation

`tests/unit/subagent-fanout-hellgate.test.ts` — 15 cases / 57 expects:

- §1 Declarative surface (4 cases): `isConcurrencySafe===true`, flag-
  independence, accepts `parallel_worker:true` without error,
  `isReadOnly===false` unchanged.
- §2 Streaming-dispatch fanout (4 cases): 3 spawns start before stream
  end; wall-clock proves concurrency (50ms × 3 < 110ms ceiling); result
  ordering preserved under reverse completion; `onToolStart` per call.
- §3 Barrier interaction (2 cases): agent × 2 + write → write deferred
  to post-barrier; write × 1 + agent × 2 → agents deferred behind the
  unsafe barrier (serial).
- §4 Depth + budget (3 cases): per-call depth increment, per-call
  maxDepth denial, unique task ids under concurrent registration.
- §5 Child isolation (2 cases): independent abort signals, parent-side
  flag does not leak into `SubagentRequest`.

Pre-existing regression suite (87 cases): `subagent-checkpoint`,
`subagent-cancellation`, `subagent-task-kind`, `subagent-continue-from`,
`subagent-6-tools-hellgate`, `streaming-dispatch`,
`streaming-dispatch-hellgate` — all pass unchanged.

## Provenance

- Source pattern: Cursor 3.2.16 agent runtime (`is_parallel_worker:true`),
  documented in `cursor-3.2-absorption` memory note.
- Existing infrastructure: `streaming-dispatch.ts` (ADR-0072 family).
- Related: ADR-0041 (subagent 6-tool standard), ADR-0130 (background
  subagent), ADR-0145 (background subagent wire), ADR-0218 (mode-typed
  delegation) — all unmutated by this ADR.

## Slice

- `src/subagent/agent-tool.ts` — `isConcurrencySafe: () => true` +
  `parallel_worker` schema field.
- `src/agent/prompt-body.ts` — one-bullet routing addition.
- `tests/unit/subagent-fanout-hellgate.test.ts` — hellgate battery (new).
- `docs/decisions/0298-subagent-fanout-parallel.md` — this document.
- `tools/feature-catalog/features/06-tier1/0298-subagent-fanout.yaml` —
  catalog row.

No mutation to `streaming-dispatch.ts`, `loop.ts`, `registry.ts`, any
plan-mode guard, permission gate, or runner.
