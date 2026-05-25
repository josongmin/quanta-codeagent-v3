/**
 * ADR-0300 — Per-tool granular checkpoint registry (in-memory snapshot store).
 *
 * Sibling of ADR-0124 `ConversationCheckpointStore`: where the conversation
 * store snapshots ONLY `messages[]` keyed by a free-form id, this registry
 * snapshots BOTH `filesBefore` (path → content) AND `taskMessagesBefore`
 * keyed by `toolCallId`. Designed for Cline's per-tool 3-way restore UX —
 * surface code / future hooks populate the registry pre-tool-call and the
 * T1 per-tool-checkpoint adapter consumes it via `restoreFiles` /
 * `restoreTask` / `restoreBoth`.
 *
 * Sibling of ADR-0203 `GranularRegistry` (`@/agent/per-tool-checkpoint`):
 * that registry is a tag→SHA index over shadow-ODB anchors. THIS registry
 * is a raw content store — no shadow-ODB, no SHAs, no I/O. The two are
 * orthogonal and can be wired together OR independently.
 *
 * # Contract (mirrors `ConversationCheckpointStore`)
 *
 * 1. PURE — Map + arithmetic only. No `node:fs`, no `node:path`, no SQLite.
 * 2. NO-THROW on every public method (`record` returns `ok:false` on cap,
 *    `restore` returns `null` on miss). The only legal throw is the
 *    pre-existing programmer-bug class (e.g. malformed config at
 *    construction).
 * 3. exactOptionalPropertyTypes — every opt gated by presence-spread
 *    (`...(x !== undefined ? { x } : {})`).
 * 4. Array-level immutability — `Object.freeze(messages.slice())`. The
 *    inner `Message` objects are caller-owned and may be mutated; the
 *    array reference is frozen so the snapshot can't be reordered.
 * 5. Same-id `record` REPLACES (per Cline restore-tool semantics — the
 *    operator may re-snapshot before re-running the same tool call). The
 *    replacement updates `takenAt` AND moves the entry to the LRU "newest"
 *    position.
 * 6. LRU eviction at `maxEntries` (default 50).
 * 7. Per-snap caps:
 *    - `filesBefore.size > maxFilesPerSnap` (default 20) ⇒ `over-cap`
 *    - sum of content byte-lengths > `maxBytesPerSnap` (default 5MB) ⇒
 *      `over-cap`
 *    On `over-cap` the registry DOES NOT insert. The caller decides
 *    whether to fall back to a partial snapshot or skip.
 *
 * # Recording protocol
 *
 * The loop / dispatch NEVER auto-records into this registry. Surfaces /
 * future hooks (`/rewind-tool`, auto-recovery on tool error) own the
 * recording cadence. The slot on `AgentConfig` is helper-only — present so
 * the composition root can pass the registry to surface adapters without
 * re-building it.
 *
 * # Plane-clean
 *
 * - Imports ONLY `@/llm` (for the `Message` type).
 * - Does NOT import `@/storage`, `@/permission`, `@/observability`,
 *   `@/agent/dispatch`, `@/agent/loop`, `@/agent/effect-channel`,
 *   `node:fs`, `node:path`.
 *
 * Mirrors the `conversation-checkpoint.ts` slice-fence (ADR-0190).
 */

import type { Message } from "@/llm"

/** One captured per-tool snapshot. Returned by `restore` / `list` (the
 *  list shape strips `filesBefore` + `taskMessagesBefore` for cheap
 *  enumeration). */
export interface ToolSnapshot {
  /** Caller-supplied tool-call id (typically a stream-unique opaque
   *  identifier — the same id the surface uses to correlate
   *  pre/post-tool effects). Empty string permitted but discouraged. */
  readonly toolCallId: string
  /** Caller-supplied turn number for diagnostics — not used for
   *  ordering. */
  readonly turn: number
  /** Epoch-ms timestamp from the injected clock at the time `record`
   *  was called. */
  readonly takenAt: number
  /** Path → content snapshot. Full file contents — caller is
   *  responsible for content selection (e.g. only the files the tool
   *  is about to mutate). Map size is capped by `maxFilesPerSnap`. */
  readonly filesBefore: ReadonlyMap<string, string>
  /** Frozen shallow copy of the messages array at capture time.
   *  Array-level immutability ONLY (inner Message objects are
   *  caller-owned). */
  readonly taskMessagesBefore: ReadonlyArray<Message>
}

/** Cheap enumeration row — same shape as `ToolSnapshot` minus the heavy
 *  `filesBefore` / `taskMessagesBefore` payloads. */
export interface ToolSnapshotMeta {
  readonly toolCallId: string
  readonly turn: number
  readonly takenAt: number
}

/** Result of `record`. Closed enum reasons match the per-snap caps. */
export type RecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "over-cap" }

/** Closed-port surface — the per-tool snapshot store. */
export interface GranularRegistryPort {
  /** Capture a snapshot under `snap.toolCallId`. Replaces any prior
   *  snapshot for the same id. Returns `ok:false, reason:"over-cap"`
   *  when the per-snap caps are exceeded (entry NOT inserted). */
  record(snap: ToolSnapshot): RecordResult
  /** Look up the snapshot. Returns `null` on miss. */
  restore(toolCallId: string): ToolSnapshot | null
  /** Enumerate ALL snapshot metas, NEWEST first. Empty array on empty
   *  store. */
  list(): ReadonlyArray<ToolSnapshotMeta>
  /** Drop all entries. */
  clear(): void
}

/** Construction opts. */
export interface GranularRegistryOpts {
  /** Cap on retained snapshots. When `record` would exceed, oldest is
   *  evicted (LRU). Default: 50. Min: 1. */
  readonly maxEntries?: number
  /** Cap on `filesBefore.size` per snapshot. Default: 20. Min: 0. */
  readonly maxFilesPerSnap?: number
  /** Cap on sum of `filesBefore` content byte-lengths per snapshot.
   *  Default: 5 * 1024 * 1024 (5MB). Min: 0. */
  readonly maxBytesPerSnap?: number
  /** Injected clock — tests pin to assert deterministic `takenAt`.
   *  Default: `Date.now`. */
  readonly now?: () => number
}
