# ADR-0231: Radar cards — background proposal queue engine (MVP)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0140 (Phase 2 background subagent), ADR-0145 (plan
  queue + 12-field follow-ups), ADR-0207 (`Stage1OutputsStore` jsonl-file
  pattern this slice reuses for `0700` dir / `0600` file mode)
- **References**: `src/radar/port.ts`, `src/radar/types.ts`,
  `src/radar/in-memory-store.ts`, `src/radar/jsonl-file-store.ts`,
  `src/radar/headless-stub.ts`, `src/radar/heuristics/idle-long-task.ts`,
  `tests/unit/radar/radar-hellgate.test.ts`

## Research grounding

Claude Desktop ships a background surface called **CoworkRadar** that
posts task suggestions as **active proposals** into a queue the operator
can consume. The IPC surface is small and stable:

- `getCards(filter)` — operator polls the queue (or the UI subscribes).
- `setCardStatus(id, status)` — accept / dismiss.
- `adoptSession(cardId)` — accept and navigate the surface to that
  session (the strongest engagement signal).
- `recordCardEngagement(id)` — soft signal: card was looked at /
  hovered, used downstream for next-card scoring.

Notably the surface separates the proposal **store** (where active
proposals live and accumulate engagement counts) from the
**heuristics** (the background routines that decide WHEN to propose a
card). The store is a tiny stable port; the heuristic side is open-ended
and grows over time.

quanta has the prerequisites (ADR-0140 background subagent, ADR-0145
plan queue with 12-field follow-ups) but **no proposal queue** — a
background suggestion has nowhere to land that survives across turns or
that the operator can review without entering the live thread. The user
surface can post hints into the plan-queue, but plan-queue follow-ups
are messages that are CONSUMED on the next turn; they are not durable
proposals the operator can scroll, dismiss, or re-engage with.

The radar slice fills exactly that gap.

## Context

Three constraints shape the MVP:

1. **Default-OFF byte-identical**. Today no quanta code path requires a
   proposal queue. The slice must be additive: callers that never
   construct a `RadarStore` see byte-identical behaviour everywhere
   else (ADR-0140 background runs, ADR-0145 plan queue, assemblers).

2. **Closed-port single surface**. The radar must expose ONE port
   (`RadarStore`) with 5 methods. Two adapters (in-memory, jsonl-file)
   exist V1; a headless deterministic stub exists for tests. Heuristics
   are PURE producers — they hand a `ProposeOpts` to the caller, who
   decides whether to push it through the store.

3. **Operator-trustable durability**. The jsonl-file adapter writes to
   `~/.quanta/radar/cards.jsonl` with `0700` directory mode and `0600`
   file mode (mirroring `Stage1OutputsStore`, ADR-0207). Corrupted
   lines are skipped with a single per-line warning and never throw —
   a bad replay must not gate the agent from making progress.

## Decision

We add a new leaf slice `src/radar` and ADR-0231 admits its surface to
the repo. The slice exposes:

**Types** (`src/radar/types.ts`):

- `RadarCard` — 8 fields: `id`, `kind`, `title`, `description`,
  `sessionId?`, `createdAtMs`, `status`, `engagementCount`.
- `CardKind` — `"suggestion" | "warning" | "next-step"`.
- `CardStatus` — `"active" | "adopted" | "dismissed" | "expired"`.
  The fourth status `"adopted"` is distinct from `"active"`: it is set
  by the operator confirming a card via the UI's "adopt this session"
  action and is the strongest engagement signal a card can carry.
- `ProposeOpts` — the surface a heuristic emits; the caller turns it
  into a stored `RadarCard` by calling `RadarStore.proposeCard(opts)`.

**Port** (`src/radar/port.ts`) — `RadarStore` with 5 methods:

- `proposeCard(opts) → RadarCard` (id minted; status forced to
  `"active"`).
- `listActive() → readonly RadarCard[]` (frozen).
- `setStatus(id, status) → Result<RadarCard, "not-found">`.
- `recordEngagement(id) → Result<RadarCard, "not-found" | "not-active">`.
- `prune(olderThanMs, now) → number` (marks all `"active"` cards whose
  `createdAtMs < now - olderThanMs` as `"expired"`; returns count
  expired).

**Adapters**:

- `in-memory-store.ts` — `Map<id, RadarCard>` + LRU eviction once a
  configurable `cap` is exceeded (oldest `createdAtMs` first). Pure,
  no I/O — primary test target.
- `jsonl-file-store.ts` — append-only ops log (`propose`, `setStatus`,
  `recordEngagement`) at `~/.quanta/radar/cards.jsonl`. Replays into an
  in-memory map on construction; bad lines are skipped with a per-line
  warning via the injected logger (no-op default). `0700` dir / `0600`
  file (chmod-tightened on every append for crash-safety against a
  pre-existing wider mode).
- `headless-stub.ts` — deterministic no-engagement stub for tests of
  callers that need a `RadarStore` shape but don't exercise it.

**Heuristic** (`src/radar/heuristics/idle-long-task.ts`):

One sample heuristic — `proposeOnIdleForLongTask({ idleMs,
lastTaskDurationMs, idleThresholdMs, taskDurationThresholdMs })` —
returns either a `ProposeOpts` or `null`. **Pure** (no I/O, no clock);
the caller hands the result to the store. This single example calibrates
the surface; production grows the catalog.

## Architecture invariants (HARD)

- `exactOptionalPropertyTypes: true` — optional fields use the
  `omitUndef` helper when constructed from possibly-undefined sources.
- Slice is a leaf: imports only from `@/shared`. No `@/agent`,
  `@/memory`, `@/scheduler`, `@/runtime`, `@/observability`, `@/tool`,
  `@/media`, `@/realtime`.
- `listActive()` returns a **readonly** array and each element is
  `Object.freeze`-d — mutation attempts throw in strict mode.
- jsonl-file adapter: directory mode `0700`, file mode `0600`. chmod
  retried on every append (best-effort, swallowed if it fails).
- Default-OFF: no other slice imports `@/radar` in V1. The store is
  constructed only by call sites that explicitly opt in (V1: tests).

## Consequences

**Gains:**

- The proposal-queue surface that ADR-0140 / ADR-0145 were missing now
  exists. Background routines have a place to deposit suggestions
  without burning a plan-queue follow-up slot or interrupting a turn.
- Engagement-count signal is now a first-class observable a future
  scorer (re-rank, importance weighting) can consume.
- Mirror of `Stage1OutputsStore`'s tightened-mode jsonl pattern —
  operationally familiar.

**Deferred:**

- **UI integration** — no surface in `apps/cli` or `apps/web` consumes
  `RadarStore` in V1. The proposal queue is observable only via test
  inspection; the operator-facing surface is the next sprint.
- **Heuristic catalog growth** — V1 ships ONE example
  (`idle-long-task`). Production needs many more (stuck-loop detector,
  abandoned-todo finder, watcher-fired suggestion, etc.).
- **OTel emission** — propose / setStatus / recordEngagement should
  emit metric counters keyed by `kind` and `status` so engagement
  signal is observable from telemetry. Follow-up.
- **Compaction** — like `Stage1OutputsStore`, the jsonl-file adapter
  never rewrites the log. A future compactor pass will be needed for
  long-lived installations.

**Negative invariants:**

- The radar must NOT auto-execute proposed actions. Adoption is an
  explicit operator gesture (`setStatus(id, "adopted")` or the future
  UI's `adoptSession` shortcut). The radar is a **suggestion** queue,
  not a worker queue.
- Heuristics MUST stay pure. No clock, no I/O, no store reference.
  The caller decides whether to deposit the proposal.
- The radar must NOT replace the plan-queue or the background-subagent
  surface. It is orthogonal: plan-queue carries messages consumed next
  turn; radar carries durable proposals reviewed at the operator's
  pace.
