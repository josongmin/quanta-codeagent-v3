/**
 * ADR-0203 + ADR-0205 — Per-tool-call checkpoint granularity + 3-way restore
 *
 * Closed-port surface for the slice.  Two ports + supporting types live here
 * so the implementation files (`granular-policy.ts`, `three-way-restore.ts`,
 * `index.ts`) all reference a single source of truth.
 *
 * The slice extends — does NOT mutate — three pre-existing pieces:
 *
 *   - `CheckpointPolicy` (ADR-0121, `@/agent/checkpoint-policy`) — pre-tool
 *     auto-anchor with 4-arm trigger modes. We add a NEW axis ("granularity")
 *     orthogonal to the trigger axis: at what GRAIN are anchors taken?
 *     Today the mode controls WHEN (per-mutating / pre-destructive / per-
 *     turn); granularity adds a separate dimension for the tag/name of the
 *     anchor so the same anchor can be a "turn"-grain SHA, a "tool"-grain
 *     SHA, or (future) "skill"-grain SHA. Granularity "turn" is the default
 *     and is BYTE-IDENTICAL to the pre-ADR-0203 path (legacy tag policy).
 *
 *   - `ShadowOdb` (ADR-0108, `@/storage/shadow-odb`) — file-side snapshot.
 *     We CONSUME its surface but never extend it: per-tool granularity is a
 *     POLICY over the existing `registerHead` + (separately) `restorePartial`
 *     / `rewindToLast`. The shadow store does not know about tags; the
 *     granular policy carries them in-memory.
 *
 *   - `ConversationCheckpointStore` (ADR-0124, `@/agent/conversation-
 *     checkpoint`) — message-side snapshot. We CONSUME its surface for the
 *     "task" leg of the 3-way restore. The store does not know about file
 *     state; the 3-way restore port composes file + conversation in one
 *     typed envelope.
 *
 * # 3-way restore (ADR-0205) — Cline pattern absorption
 *
 * Cline's UI offers "Restore Files Only" / "Restore Task Only" / "Restore
 * Both" as three discrete commands. We surface the same three legs as a
 * closed-port surface (`ThreeWayRestorePort`) with the SAME typed result
 * shape (`RestoreOutcome`) so a future surface (REPL, Tauri, JSON-RPC) can
 * paint a diff/transcript panel from the typed result without re-querying.
 *
 * The default impl composes ShadowOdb (for files) + ConversationCheckpoint-
 * Store (for task). Each leg is INDEPENDENT (orthogonal):
 *
 *   - `restoreFiles(ref)` → ONLY files. Conversation snapshot is untouched.
 *   - `restoreTask(ref)`  → ONLY conversation. Files are untouched.
 *   - `restoreBoth(ref)`  → both legs, in deterministic order
 *                          (files first; conversation is in-memory and
 *                          cannot fail mid-write).
 *
 * # No-throw posture (all four files in this slice)
 *
 * Every public method on both ports is NO-THROW. Failures collapse to a
 * `RestoreOutcome` with `ok: false` + a typed error code. Mirrors the
 * `CheckpointPolicy` (ADR-0121) fail-OPEN posture: observability-class
 * instrumentation MUST NOT break the loop.
 *
 * The only legal throw is a programmer-bug (e.g. invalid configuration at
 * construction time) — same posture as `ConversationCheckpointStore`.
 *
 * # exactOptionalPropertyTypes
 *
 * Every optional field on every type is `field?: T` (NEVER `field: T |
 * undefined`). Construction sites use conditional spreads
 * (`...(x !== undefined ? { x } : {})`) so `tsc` never sees `field: undefined`.
 *
 * # What this file is NOT
 *
 * - It is NOT an EffectChannel wrap. Auto-anchor wiring lives in
 *   `granular-policy.ts` (which builds a `CheckpointPolicy` consumed by the
 *   existing `withAutoCheckpoint` wrap). The wrap stays in
 *   `@/agent/checkpoint-policy` — we do not duplicate it.
 * - It is NOT a slash command. The `/rewind-tool` command lives in
 *   `@/apps/cli/rewind-tool-cmd.ts` and consumes this port via DI.
 * - It is NOT a registry of tagged anchors with persistence — the in-memory
 *   tag→SHA registry is per-session (matches `ConversationCheckpointStore`).
 *   Persistence is a follow-up.
 */

import type { CheckpointPolicy } from "@/agent/checkpoint-policy"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { Message } from "@/llm"
import type { ShadowOdb } from "@/storage/shadow-odb"

/* ------------------------------------------------------------------ */
/* Granularity axis (ADR-0203)                                         */
/* ------------------------------------------------------------------ */

/** Closed enum of anchor granularities. Expanding requires an ADR
 *  amendment + every exhaustive switch becomes a compile error (matches the
 *  `CheckpointTriggerMode` posture in ADR-0121).
 *
 *  - `"turn"`  — DEFAULT. Anchors are tagged at the per-turn grain. Byte-
 *                identical to the pre-ADR-0203 path: the granular policy
 *                short-circuits to the underlying `CheckpointPolicy` so the
 *                wrap performs zero extra work.
 *  - `"tool"`  — Per tool-call. Each destructive tool call gets its OWN
 *                tag `tool:<name>:<turnId>:<callIndex>` (assigned per-
 *                workspace by an in-memory counter). The same underlying
 *                `ShadowOdb.registerHead` call is taken — the difference
 *                is the policy ALWAYS approves the anchor (no per-turn
 *                dedup) and records a tag→SHA entry for `/rewind-tool`.
 *  - `"skill"` — Reserved (Codex SKILL boundary). Default impl treats it
 *                identically to `"turn"` until the skill boundary is wired
 *                into the dispatch plane. Surfaced TODAY only so the enum
 *                is grep-stable — adding the third arm later does NOT
 *                require an ADR amendment.
 */
export type CheckpointGranularity = "turn" | "tool" | "skill"

/** A symbolic tag identifying ONE anchor in the granular registry. Format
 *  follows Cline's UX: `tool:<name>:<turnId>:<callIndex>` for tool-grain,
 *  `turn:<turnId>` for turn-grain, `skill:<name>:<turnId>` for skill-grain.
 *  The format is INTERNAL — callers SHOULD use `GranularRegistry.list()` to
 *  enumerate rather than constructing tags by hand. */
export type CheckpointTag = string

/** One entry in the in-memory tag→SHA registry. Returned by
 *  `GranularRegistry.list()`. Sorted newest-first. */
export interface GranularCheckpointEntry {
  /** Anchor tag — see {@link CheckpointTag} format. */
  readonly tag: CheckpointTag
  /** Granularity that produced this tag. */
  readonly granularity: CheckpointGranularity
  /** The `ShadowOdb.registerHead` SHA — 40-hex commit id. */
  readonly sha: string
  /** Epoch-ms timestamp from the injected clock at anchor time. */
  readonly takenAt: number
  /** Optional tool name (present iff granularity === "tool"). */
  readonly toolName?: string
  /** Actual dispatched tool-call identity when the dispatch seam supplied it. */
  readonly toolCallId?: string
  /** Optional turn id (present for tool / turn / skill grain when caller
   *  supplied a turnId via `ToolContext`). */
  readonly turnId?: string
  /** Optional per-turn call index (present iff granularity === "tool"). */
  readonly callIndex?: number
}

/** In-memory registry of tagged shadow-ODB anchors. Per-session, no
 *  persistence — survives the lifetime of the granular-policy instance.
 *  Pure surface (no I/O): the registry is populated as a side effect of
 *  `recordAnchored` calls (see {@link GranularCheckpointPolicy}). */
export interface GranularRegistry {
  /** Enumerate ALL tagged anchors, NEWEST first. Empty when no anchors
   *  have been recorded. */
  list(): ReadonlyArray<GranularCheckpointEntry>
  /** Look up an entry by tag. Returns `null` when the tag is unknown.
   *  Tags are case-sensitive. */
  lookup(tag: CheckpointTag): GranularCheckpointEntry | null
  /** Drop all entries. Mirrors `ConversationCheckpointStore.clear`. */
  clear(): void
}

/* ------------------------------------------------------------------ */
/* GranularCheckpointPolicy (ADR-0203)                                 */
/* ------------------------------------------------------------------ */

/** Closed-port surface extending the ADR-0121 `CheckpointPolicy` with the
 *  granularity axis + the tag registry.
 *
 *  Behaviour by granularity:
 *
 *  - `"turn"` — the policy DELEGATES every method (`shouldAnchorBefore`,
 *               `shouldAnchorAfterTurn`, `recordAnchored`) to the wrapped
 *               `CheckpointPolicy` verbatim. The registry stays EMPTY.
 *               Byte-identical to pre-ADR-0203.
 *  - `"tool"` — `shouldAnchorBefore` returns `true` for every destructive
 *               tool call (overrides the per-turn dedup in the underlying
 *               policy). `recordAnchored` registers a `tool:<...>` tag
 *               into the registry AND delegates to the underlying policy.
 *               `shouldAnchorAfterTurn` returns `false` (per-turn anchors
 *               are a tool-grain concern only).
 *  - `"skill"` — reserved; treated as `"turn"` until skill-boundary is wired.
 *
 *  The 4-arm trigger mode from ADR-0121 (`off` / `pre-destructive` / `per-
 *  mutating` / `per-turn`) is ORTHOGONAL: when the trigger mode is `"off"`,
 *  no anchor is taken regardless of granularity (byte-identical to ADR-0121
 *  off-mode). */
export interface GranularCheckpointPolicy extends CheckpointPolicy {
  /** Active granularity (read-only — set at construction time). */
  readonly granularity: CheckpointGranularity
  /** The tag registry (always present, may be empty). */
  readonly registry: GranularRegistry
  /** Record an anchor SHA against a TAG. Called by the EffectChannel wrap
   *  AFTER the underlying `ShadowOdb.registerHead` returns the SHA so the
   *  registry has the actual commit id (not just the tag).
   *
   *  NO-THROW: callers may invoke this even when the underlying anchor
   *  rejected (the SHA would be a sentinel "" — the registry treats empty
   *  SHA as "anchor failed" and SKIPS the insert; the dedup record on the
   *  underlying policy is still kept).
   *
   *  When the policy's granularity is `"turn"`, this method is a NO-OP for
   *  the registry (the underlying policy already recorded the dedup key).
   */
  recordAnchorSha(tag: CheckpointTag, sha: string, ctx: AnchorContext): void
  /** Compute the canonical tag for an upcoming anchor. Pure — no
   *  registry mutation. Used by the EffectChannel wrap so the same tag
   *  flows through `recordAnchorSha`. Returns `null` when the policy's
   *  granularity is `"turn"` (turn-grain anchors are not tagged in the
   *  registry — they live ONLY in the underlying `CheckpointPolicy`'s
   *  dedup set, which is the legacy behaviour). */
  computeTag(ctx: AnchorContext): CheckpointTag | null
}

/** Per-anchor context that the EffectChannel wrap passes to
 *  `recordAnchorSha` / `computeTag`. Carries the orthogonal fields the
 *  granular policy needs to assemble a tag without reaching into
 *  `ToolUseBlock` / `ToolContext` (slice isolation). All fields optional
 *  to keep the call site flexible. */
export interface AnchorContext {
  readonly workspace: string
  readonly turnId?: string
  readonly toolName?: string
  /** Actual dispatched call identity. When present it is the canonical tool tag suffix. */
  readonly toolCallId?: string
  /** Per-turn monotonic call index supplied by the caller (typically the
   *  wrap maintains a counter per (workspace, turnId) pair and increments
   *  it on every destructive call within the turn). */
  readonly callIndex?: number
  /** Optional skill name (reserved — see `CheckpointGranularity.skill`). */
  readonly skillName?: string
}

/** Configuration for `defaultGranularCheckpointPolicy`. */
export interface GranularCheckpointPolicyConfig {
  /** Underlying ADR-0121 policy. The granular policy DELEGATES to it for
   *  the trigger-mode decisions; it never re-implements the 4-arm enum. */
  readonly base: CheckpointPolicy
  /** The chosen granularity. */
  readonly granularity: CheckpointGranularity
  /** Injected clock — tests pin to assert deterministic `takenAt`.
   *  Default: `Date.now`. */
  readonly now?: () => number
  /** Cap on the registry entry count. LRU-evicts oldest when exceeded.
   *  Mirrors `ConversationCheckpointStore.maxEntries`. Default: 200
   *  (per-tool anchors are higher-frequency than per-turn snapshots).
   *  Min: 1. */
  readonly maxRegistryEntries?: number
}

/* ------------------------------------------------------------------ */
/* ThreeWayRestorePort (ADR-0205)                                      */
/* ------------------------------------------------------------------ */

/** Closed enum of typed restore-failure codes. `none` is reserved for the
 *  success case (`ok: true`). */
export type RestoreErrorCode =
  /** The granular registry did not contain the requested tag. */
  | "tag-not-found"
  /** The `ShadowOdb` was not wired (file leg requested without
   *  `ports.shadowOdb`). */
  | "shadow-odb-not-configured"
  /** The `ConversationCheckpointStore` was not wired (task leg requested
   *  without `ports.conversationStore`). */
  | "conversation-store-not-configured"
  /** The conversation snapshot for the resolved id was not found in the
   *  store (it may have been evicted by LRU). */
  | "task-snapshot-missing"
  /** The shadow-ODB rewind failed (typed `ShadowOdbError`). The
   *  `originalCode` field on the outcome carries the underlying code. */
  | "shadow-rewind-failed"

/** Typed result of any `restore*` call. NEVER thrown — the port collapses
 *  every failure (including programmer-bug input) into this envelope.
 *
 *  Files-leg metadata (`filesChanged`, `unifiedDiff`) are POPULATED only
 *  when the call requested the files leg (`restoreFiles` / `restoreBoth`)
 *  AND the leg succeeded.
 *
 *  Task-leg metadata (`messagesBefore`, `messagesAfter`) similarly only
 *  populated when the call requested the task leg. */
export interface RestoreOutcome {
  /** `true` ⇒ every requested leg succeeded; `false` ⇒ at least one leg
   *  failed. On `ok:false`, `errorCode` is set; on `ok:true` it is
   *  OMITTED (exactOptionalPropertyTypes). */
  readonly ok: boolean
  /** Closed-enum error code when `ok:false`. */
  readonly errorCode?: RestoreErrorCode
  /** Free-form human message for logs / surface display. Always present
   *  (even on success — describes what was restored). */
  readonly message: string
  /** Original `ShadowOdbError.code` when `errorCode === "shadow-rewind-
   *  failed"`. Helps the surface distinguish `merge-in-progress` from
   *  `rewind-failed` etc. without re-introspecting. */
  readonly originalCode?: string
  /** ABSOLUTE workspace-relative paths that the file-leg restore touched.
   *  Empty array on success-without-changes. Absent when files leg not
   *  requested. */
  readonly filesChanged?: ReadonlyArray<string>
  /** Snapshot of the messages array AFTER the task-leg restore (frozen,
   *  same reference as `ConversationCheckpointStore.restore` returned).
   *  Absent when task leg not requested. */
  readonly messagesAfter?: ReadonlyArray<Message>
  /** Snapshot of the messages array BEFORE the task-leg restore. Helps a
   *  UI render the conversation diff. Absent when task leg not requested.
   *  May be empty when caller did not supply `currentMessages`. */
  readonly messagesBefore?: ReadonlyArray<Message>
  /** The resolved tag the restore targeted (canonical form). Always
   *  present so a caller can correlate with `GranularRegistry.list`. */
  readonly tag: CheckpointTag
}

/** Options for `restoreFiles` / `restoreTask` / `restoreBoth`. */
export interface RestoreOptions {
  /** Required when invoking `restoreTask` / `restoreBoth` so the outcome's
   *  `messagesBefore` reflects the LIVE conversation at restore time.
   *  Absent ⇒ `messagesBefore` is set to an empty array. */
  readonly currentMessages?: ReadonlyArray<Message>
  /** Allow rewind across an in-progress merge. Defaults to `false`
   *  (matches `ShadowOdb.rewindToLast` posture). */
  readonly allowDirtyMerge?: boolean
}

/** Closed-port surface for the 3-way restore. */
export interface ThreeWayRestorePort {
  /** Restore FILES only — conversation unchanged. */
  restoreFiles(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome>
  /** Restore TASK (conversation) only — files unchanged. */
  restoreTask(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome>
  /** Restore BOTH legs in deterministic order: files first, conversation
   *  second. On files-leg failure the conversation leg is NOT attempted
   *  (the outcome's `errorCode` reflects the file leg). */
  restoreBoth(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome>
}

/** Ports injected into `defaultThreeWayRestore`. Both are optional —
 *  absent ports surface as typed errors at call time (NEVER as a
 *  programmer-bug throw at construction time). */
export interface ThreeWayRestorePorts {
  readonly registry: GranularRegistry
  readonly workspace: string
  readonly shadowOdb?: ShadowOdb
  readonly conversationStore?: ConversationCheckpointStore
}
