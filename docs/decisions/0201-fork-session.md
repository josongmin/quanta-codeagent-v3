# ADR-0201: Fork session (parent-child snapshot branching)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0119 (`shadow_rewind` tool), ADR-0124
  (`ConversationCheckpointStore` — the in-memory LRU snapshot/restore
  primitive this slice extends), ADR-0166 (subagent conversation seed
  replay — a sibling consumer of `ConversationCheckpointStore`).

## Context

A four-way agent comparison (Claude / Cursor / Codex / quanta) shows that
both Claude and Cursor expose `rewind + fork` as a paired primitive:
**rewind** restores history to a prior point, **fork** branches a NEW
parallel session from that same snapshot so the original session is
unaffected. Codex only ships `rewind`. quanta today only ships `rewind`
(ADR-0119) — fork is the missing half of the standard 2-vendor pattern.

The in-memory snapshot primitive `ConversationCheckpointStore`
(ADR-0124, LRU-backed Map) already records `messages[]` history under a
caller-supplied id and serves restore (used by `shadow_rewind`-class
callers). The extension surface needed for fork is small: a
`cloneSnapshot(srcId, dstId)` op (record the SAME snapshot under a new
key, preserving immutability) and a `lineageOf(id)` op (track the
parent → child relationship so a future UX can render the fork tree).

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** No fork tool registered unless the
  composition root opts in (`config.fork` set OR `QUANTA_FORK_ENABLED=1`
  + the helper). Sessions that never wire it see zero new tools, zero
  new state, zero registry change.
- **Snapshot immutability.** Forking a checkpoint must NOT couple parent
  and child: post-fork mutations on the parent's `messages[]` array
  must not appear in the forked handle's `messages`. ADR-0124 already
  shallow-freezes the array on `record`; `cloneSnapshot` keeps the
  same frozen reference under the new id (the underlying array is
  IMMUTABLE — sharing it is safe).
- **No loop coupling.** This is a HELPER PRIMITIVE. The loop
  (`@/agent/loop`, `@/agent/dispatch`) does NOT import the fork slice;
  fork lives at the same plane as `conversation-checkpoint.ts` /
  `plan-queue.ts` / `budget-ledger.ts`.
- **`exactOptionalPropertyTypes: true`.** Every optional field on the
  returned handle is conditional-spread (no `undefined` literal slot).
- **Closed-port DIP.** `SessionForker` is the port; `defaultSessionForker`
  is the default-impl. Future test-doubles satisfy the port without
  reaching into the slice internals.

## Decision

Stand up a new helper slice `src/agent/fork-session/` (4 files +
barrel) plus a closed-port DI seam (`SessionForker`) plus a
`fork_session` tool (`src/tool/shadow/fork.ts`) registered by the
shadow-tool builder when the composition root wires it.

```
src/agent/fork-session/
  port.ts              — `SessionForker { fork(checkpointId) → Result<ForkedSessionHandle, ForkError> }`
  default-forker.ts    — adapter over `ConversationCheckpointStore` + lineage tracker
  lineage.ts           — `Map<sessionId, { parent: string | null; forkedAt: number }>` + cycle guard
  types.ts             — `ForkedSessionHandle` / `ForkError` (closed 4-arm union)
  index.ts             — barrel
src/agent/conversation-checkpoint.ts  — EXTENDED with `cloneSnapshot` + `lineageOf`
src/tool/shadow/fork.ts               — `fork_session` Tool (wraps the port)
src/tool/shadow/index.ts              — re-export `forkSessionTool` + add to `shadowTools` ONLY when a forker port is supplied
src/agent/tier1/fork-session.ts       — tier-1 block (returns `[]` when `config.fork` absent)
src/agent/features.ts                 — call new block; composer change is one push line
src/agent/types.ts                    — add `fork?: { forker: SessionForker }` slot
```

Public shape of `SessionForker.fork`:

```ts
fork(checkpointId: string): Result<ForkedSessionHandle, ForkError>

type ForkedSessionHandle = {
  sessionId: string         // new uuid (crypto.randomUUID())
  parentSessionId: string
  parentCheckpointId: string
  forkedAt: number          // epoch-ms from injected clock
  messages: ReadonlyArray<Message>
}

type ForkError =
  | { code: "checkpoint-not-found"; message: string }
  | { code: "store-full"; message: string }
  | { code: "lineage-cycle"; message: string }
  | { code: "duplicate-id"; message: string }
```

Semantic mapping (operation → underlying primitive):

| op                        | underlying call                                             |
|---------------------------|-------------------------------------------------------------|
| `fork(checkpointId)`      | `store.cloneSnapshot(srcId, newId)` + `lineage.attach(child→parent)` |
| `cloneSnapshot(src, dst)` | (extension) reuse the FROZEN messages array under `dst`     |
| `lineageOf(id)`           | (extension) read-only `{ parent: string \| null }` lookup   |

The `cloneSnapshot` policy is **strict no-overwrite**: if `dstId`
already exists in the store, it returns `false` (the `fork` layer maps
that to `Err("duplicate-id")`). Overwrite-on-collision would silently
corrupt the parent's snapshot if `newId` ever collided with an existing
id (extremely unlikely with `crypto.randomUUID()`, but the safer
default is explicit failure — fork is rare and a real collision is a
programmer bug, not a runtime condition to swallow).

The `lineage` is a SEPARATE Map (not stored on the snapshot itself) so
the conversation-checkpoint primitive stays single-purpose. Cycle
guard: `attach(child, parent)` rejects if `child` is already an
ancestor of `parent` (walks the parent chain; `Err("lineage-cycle")`
on contact). Default LRU-style cap on the lineage map (defaults to 200
entries, same magnitude as the snapshot cap) so a runaway forker
cannot wedge memory.

Default-OFF wiring posture (mirrors `shadowOdb`):

- `AgentConfig.fork` absent ⇒ `buildForkBlock(config)` returns `[]`,
  composer adds nothing, `ToolRegistry` is byte-identical.
- `AgentConfig.fork.forker` set ⇒ `forkSessionTool(forker)` is
  registered. The composition root constructs the forker over the same
  `ConversationCheckpointStore` it uses for `record`.

## Hellgate (17 cases, all default-OFF)

`tests/unit/agent/fork-session-hellgate.test.ts` (13 cases):

| id        | seal                                                                        |
|-----------|-----------------------------------------------------------------------------|
| HELL-F-01 | `fork("unknown")` → `Err("checkpoint-not-found")` (no throw)                |
| HELL-F-02 | `fork(known)` → handle.messages deep-equal parent snapshot                  |
| HELL-F-03 | new `sessionId !== parentSessionId` AND matches UUID-v4 regex               |
| HELL-F-04 | parent `record(parentId, …)` post-fork does NOT mutate forked.messages      |
| HELL-F-05 | 2 forks of same checkpoint → 2 distinct sessionIds, same messages           |
| HELL-F-06 | `lineageOf(forkedSid).parent === parentSessionId`                           |
| HELL-F-07 | nested fork (A→B fork; B→C fork) → C's lineage chain reaches A              |
| HELL-F-08 | store at cap → fork still succeeds (cloneSnapshot evicts oldest non-parent) |
| HELL-F-09 | parent checkpoint pruned away → fork → `Err("checkpoint-not-found")`        |
| HELL-F-10 | `cloneSnapshot(src, existingDst)` → `false` (no-overwrite); fork maps to `duplicate-id` |
| HELL-F-11 | `lineage.attach(A→B)` after A is an ancestor of B → `Err("lineage-cycle")`  |
| HELL-F-12 | `forked.messages` is the SAME frozen array as the snapshot (readonly)       |
| HELL-F-13 | 1000 forks → lineage map respects its own cap (no unbounded growth)         |

`tests/unit/tool/shadow-fork-hellgate.test.ts` (4 cases):

| id         | seal                                                                          |
|------------|-------------------------------------------------------------------------------|
| HELL-FT-01 | tool input `{ checkpointId }` → output mentions sessionId, parentSessionId, forkedAt |
| HELL-FT-02 | unknown checkpointId → `{ ok:false, output: "checkpoint-not-found: …" }`      |
| HELL-FT-03 | tool is constructed with a forker port (no global state, no module-load wiring) |
| HELL-FT-04 | shadow-tool builder excludes `fork_session` when no forker is supplied        |

## Consequences

- **+ Parity** with Claude / Cursor on the rewind+fork pair without coupling
  the loop. Future UX can ship a `/fork` slash command on top.
- **+ Subagent-friendly.** A future `subagent_fork_from_checkpoint`
  variant can call this same primitive; the forked sessionId is a
  clean handle the background scheduler can attach to.
- **−** Two new in-memory maps (lineage + extended snapshot store).
  Cap = 200 entries (same magnitude as snapshot cap, ~200 × 200 bytes
  per entry ≈ 40 KB worst-case).
- **−** `cloneSnapshot`'s no-overwrite policy means a caller that
  passes a deliberately-colliding id gets an Err; this is the safe
  default but documenting the inverse policy as a future option is
  worth a follow-up if a real use case appears.

## Follow-up

- `/fork` slash command in `src/apps/cli/repl` (separate ADR; sits on
  top of this port).
- Subagent integration: pass a forked sessionId as the seed to
  `BackgroundSubagentScheduler.spawn` so a forked branch executes in
  parallel without touching the parent's history.
- LRU swap consistency: when ADR-0184's lru-cache adapter becomes the
  canonical store, `cloneSnapshot` lifts to a `cache.set(dstId,
  cache.peek(srcId))` one-liner; no port-shape change.
