# ADR-0300 — Per-tool granular checkpoint registry (in-memory snapshot store)

Status: accepted
Date: 2026-05-26

## Context

T1 ADR-0291 (`src/apps/cli/repl/ctx-adapters/per-tool-checkpoint-adapter.ts`)
landed the Cline 3-way restore shape (`restoreFiles` / `restoreTask` /
`restoreBoth`) over `@/agent/per-tool-checkpoint` (ADR-0203 + ADR-0205) —
a tag→SHA registry over shadow-ODB anchors. The adapter exposes a sibling
stub arm: when the host has no shadow-ODB but still wants the
slash-surface contract to seal, every `restoreXxx` returns a typed
`RestoreOutcome { ok:false, errorCode: "shadow-odb-not-configured" }`.

The stub is honest but inert: with NO upstream source of per-tool
snapshots, `/rewind-tool` (and any future auto-recovery hook) can't
restore. Cline's actual UX records BOTH file content AND task messages
pre-tool-call (independent of shadow-ODB), in a lightweight in-memory
store that survives the session. ADR-0124's `ConversationCheckpointStore`
is the same shape for messages-only; we are missing the files+messages
sibling.

## Decision

Introduce `src/agent/checkpoint/granular-registry/` — a NEW slice (sibling
of `conversation-checkpoint.ts`) that provides a pure in-memory
`GranularRegistryPort`. The port stores `ToolSnapshot` rows keyed by
`toolCallId`:

```ts
interface ToolSnapshot {
  toolCallId: string
  turn: number
  takenAt: number
  filesBefore: ReadonlyMap<string, string>   // path → content
  taskMessagesBefore: ReadonlyArray<Message>
}
```

Port shape (closed):

```ts
interface GranularRegistryPort {
  record(snap: ToolSnapshot): { ok: true } | { ok: false; reason: "over-cap" }
  restore(toolCallId: string): ToolSnapshot | null
  list(): ReadonlyArray<ToolSnapshotMeta>
  clear(): void
}
```

Opts:

| field | default | min |
|-------|---------|-----|
| `maxEntries` | 50 | 1 |
| `maxFilesPerSnap` | 20 | 0 |
| `maxBytesPerSnap` | 5 * 1024 * 1024 | 0 |
| `now` | `Date.now` | — |

T1 adapter wire (`per-tool-checkpoint-adapter.ts`) gains a NEW sibling
factory `createPerToolCheckpointAdapter(opts?: { registry?: GranularRegistryPort })`
returning a `PerToolCheckpointSnapshotAdapter` with 3 sibling arms:

- `restoreFiles(toolCallId)` → `{ ok:true, files }` or typed Err
- `restoreTask(toolCallId)`  → `{ ok:true, messages }` or typed Err
- `restoreBoth(toolCallId)`  → `{ ok:true, files, messages }` or typed Err

The existing `buildPerToolCheckpointAdapter` (consumed by
`slash-surface.ts`) is UNTOUCHED — it continues to return the
`PerToolCheckpointSlashState` shape used by `/rewind-tool`. The new
factory is a SIBLING that future composition roots / hooks consume
directly.

Restore semantics (snapshot-arm):

- absent registry ⇒ every arm returns
  `{ ok:false, errorCode: "shadow-odb-not-configured" }`
  (matches the existing T1 stub posture; the surface contract stays
  byte-identical for every legacy caller)
- registry present, id missing ⇒ `{ ok:false, errorCode: "not-found" }`
- registry present, registry throws ⇒
  `{ ok:false, errorCode: "registry-failure", message }`
  (NO-THROW posture; surfaces NEVER crash on a misbehaving registry)
- registry present, id hit ⇒ `{ ok:true, ... }` returning the stored
  `filesBefore` Map and/or frozen `taskMessagesBefore` array.

The adapter does NOT write files or mutate task messages. It RETURNS the
raw snapshot payloads — the caller (`/rewind-tool` slash, future hook)
decides how to apply them through surface-owned write paths.

## AgentConfig slot

```ts
/**
 * ADR-0300 — per-tool granular checkpoint registry. Sibling of
 * conversationCheckpoint for ADR-0124's conversation face: this slot
 * owns per-tool-call file+task snapshots that the rewind-tool slash +
 * future auto-recovery hook consume. Absent ⇒ slot OMITTED (default-OFF
 * byte-identical). Caller-side composition only — loop NEVER reads it.
 */
granularRegistry?: GranularRegistryPort
```

## Recording protocol

The loop / dispatch NEVER auto-record snapshots into this registry.
Surfaces (`/rewind-tool` UX, future tool-error auto-recovery hook) own
the recording cadence. Auto-recording from the dispatch plane is an
intentional follow-up — it would require wiring a pre-tool-call hook
that snapshots the FILES the tool is about to mutate (deferring that
read until after permission check, so denied tools never pay the I/O
cost) and a post-tool-error hook that triggers automatic restore. That
work touches `dispatch.ts` and is explicitly OUT of scope for this slice.

## Default-OFF posture

- AgentConfig slot absent ⇒ no `granularRegistry` reference exists on
  the config object (exactOptionalPropertyTypes). The agent loop, every
  existing tool, and the dispatch plane are byte-identical.
- T1 `buildPerToolCheckpointAdapter` (slash-surface consumer) is
  UNTOUCHED — slash-surface continues to construct the same
  `PerToolCheckpointSlashState` shape using `@/agent/per-tool-checkpoint`
  (the SHA-tag registry, NOT this snapshot store).
- New `createPerToolCheckpointAdapter` factory with `registry: undefined`
  returns the same `shadow-odb-not-configured` Err posture as the
  existing T1 stub.

## Plane-clean (slice-fence)

`src/agent/checkpoint/granular-registry/` imports ONLY:

- `@/llm`   (Message type)
- `./port`  (sibling)

Forbidden by biome `noRestrictedImports` rule:

- `@/agent/loop`, `@/agent/dispatch`, `@/agent/effect-channel`
- `@/storage`, `@/permission`, `@/observability`
- `@/apps/agent`
- `node:fs`, `node:path`

Mirrors `conversation-checkpoint.ts` slice-fence (ADR-0190).

## Tests

- `tests/unit/granular-registry-hellgate.test.ts` — 14 cases / 4 blocks:
  round-trip + replace · LRU + per-snap caps · enumeration / clear /
  immutability · SSOT clock + no-throw posture.
- `tests/unit/cli/per-tool-checkpoint-adapter-wire-hellgate.test.ts` —
  6 cases: absent registry shadow-odb-not-configured pass-through,
  3-arm round-trips, not-found typed Err, throwing-registry no-throw.

20 cases total.

## Negative invariants

1. The registry NEVER persists. Process restart wipes everything.
2. `record` NEVER throws (cap rejection is a typed `ok:false` value).
3. `restore` NEVER throws (miss is a `null` value, not an exception).
4. The agent loop / dispatch NEVER reads `AgentConfig.granularRegistry`.
   This is a caller-side composition slot only.
5. The new `createPerToolCheckpointAdapter` factory NEVER throws on any
   public method (registry-thrown exceptions are wrapped in
   `Err("registry-failure")`).
6. The new factory does NOT replace `buildPerToolCheckpointAdapter`.
   They coexist as siblings — the legacy factory consumes the SHA-tag
   registry, the new factory consumes the snapshot registry.

## Promotion path (deliberate hold)

The slice provides the helper primitive + adapter wire only. Two
follow-up slices unlock end-to-end UX:

1. **Auto-record hook on dispatch**: wire a pre-tool-call hook that
   snapshots the files the tool is about to mutate (read via the FS
   port, post-permission) and the conversation messages, then calls
   `granularRegistry.record(snap)`. Touches `dispatch.ts`; needs a
   separate ADR.
2. **/rewind-tool snapshot arm**: extend the slash command so when a
   snapshot adapter is wired (via a separate `ctx.perToolCheckpointSnap`
   slot), `--mode=files|task|both` restores the stored payloads
   directly (instead of going through shadow-ODB). Touches
   `rewind-tool-cmd.ts` and `slash-surface.ts`; needs a separate ADR.

Both follow-ups are intentionally out of scope here so this slice stays
small + reviewable + default-OFF.
