import type { Message } from "@/llm"

/**
 * Id-addressable session persistence — V2 schema.
 *
 * V1 (path-based) lives in `src/agent/state.ts` and is NOT touched. This slice
 * is a NEW rail next to it: callers mint an opaque id and we keep the file at
 * `<sessionsRoot>/<id>.json` (or `<sessionsRoot>/archived/<id>.json` when
 * archived) plus a single `index.jsonl` for cheap listing. Inspired by the
 * Codex CLI's session UX.
 *
 * Schema bump: `SESSION_VERSION = 2` so a future reader can tell V1 / V2 apart
 * (their on-disk shapes differ — V2 has a `meta` envelope; V1 has flat fields).
 */
export const SESSION_VERSION = 2 as const

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastTouched: number
  archived: boolean
  /** ADR-0106 git fingerprint (Codex §18.9 absorption). Captured at session
   *  start when the cwd is a git repository; each field is independent —
   *  a detached HEAD has SHA but no branch; a local-only repo has branch
   *  but no originUrl. Absent fields mean "not captured" (cwd not a repo,
   *  spawn failure, etc.) — never lossy stripping. */
  gitSha?: string
  gitBranch?: string
  gitOriginUrl?: string
  /** Session id this transcript was forked from (`forkSession`). Absent on
   *  non-fork sessions AND on legacy transcripts minted before this field —
   *  absent means "no known parent", never lossy stripping (same discipline as
   *  the git-fingerprint fields above). Persisted so a `/fork` lineage chain
   *  survives rename + reload (the `" (fork)"` title suffix is cosmetic and
   *  mutable). The parent may later be deleted — this is provenance metadata,
   *  not a live pointer, so a dangling reference is acceptable. */
  forkedFromId?: string
  /* ----------------------------------------------------------------- */
  /* §8.2 (jun-08 long-tail) — Codex session-meta provenance fields.   */
  /* ALL OPTIONAL: absent on every legacy transcript ⇒ the (non-strict) */
  /* `sessionMetaSchema` still validates, and `JSON.stringify` drops    */
  /* `undefined` props so a session that never set them serializes      */
  /* byte-identically to the prior on-disk shape. Same discipline as    */
  /* the git-fingerprint optionals above — absent means "not captured", */
  /* never lossy stripping.                                             */
  /* ----------------------------------------------------------------- */
  /** Human-friendly agent label (Codex `agent_nickname`). Cosmetic. */
  agentNickname?: string
  /** Tool names dynamically added to this session (Codex `dynamic_tools`
   *  snapshot — the persisted set; see the `dynamic_tools` envelope record
   *  for the per-add event log). */
  dynamicTools?: string[]
  /** What spawned this session (Codex `originator` — "cli"/"vscode"/an
   *  app id). Provenance. */
  originator?: string
  /** Where the thread came from (Codex `thread_source` —
   *  "new"/"resumed"/"forked"/"subagent"). */
  threadSource?: string
  /** Provider transport that served the session (Codex `model_provider`
   *  — "anthropic"/"openai"/"chatgpt-oauth"). `model` above is the model
   *  id; this is the provider. */
  modelProvider?: string
  /* ----------------------------------------------------------------- */
  /* §13.2 (jun-08 long-tail) — PERSISTED interrupted-turn marker for   */
  /* crash recovery. The in-memory `InterruptedTurnBuffer` (jun-08)      */
  /* survives only WITHIN a process; a hard crash mid-turn loses it.     */
  /* This optional marker is written to the SNAPSHOT so a restart can    */
  /* DETECT a session that died mid-turn and OFFER to resume it. Absent  */
  /* ⇒ no interrupted turn (byte-identical default-OFF). Cleared on a    */
  /* clean turn completion. See `src/session/crash-resume.ts`.          */
  /* ----------------------------------------------------------------- */
  interruptedTurn?: PersistedInterruptedTurn
}

/** §13.2 — the persisted crash-resume marker stored on {@link SessionMeta}.
 *  Mirrors the in-memory `InterruptedTurn` shape (userText / partial progress
 *  / reason / wall-clock) so the restart-resume path can rebuild the exact
 *  same resume message the in-process buffer would have. Pure data — no
 *  behavior; absent unless a turn was persisted as interrupted. */
export interface PersistedInterruptedTurn {
  /** The user prompt that started the interrupted turn. */
  userText: string
  /** Assistant text produced before the crash/interrupt (partial progress). */
  partialAssistantText: string
  /** Why it was interrupted (e.g. "crash", a cancel reason). */
  reason: string
  /** Wall-clock ms when the turn was marked interrupted (injected clock). */
  interruptedAt: number
}

/* ------------------------------------------------------------------ */
/* RFC-01 A2 — durable ThreadRollback records (aug-02 absorption).      */
/*                                                                      */
/* These ride the EXISTING `SavedSession` atomic snapshot (same file,   */
/* same canonical encoder) — there is NO new store, writer, hash        */
/* helper, or ODB. The `@/session` slice owns the durable record shape  */
/* and its atomic I/O; the working-tree effect is owned by              */
/* `ThreeWayRestorePort`; the application service that orders them lives */
/* in `@/agent` (`thread-rollback`). See                                */
/* docs/plans/aug-02-absorption/rfc-01-persistence-resume.md.           */
/*                                                                      */
/* Schema evolution rule: BOTH collections are OPTIONAL. A legacy       */
/* snapshot minted before this field reads back as an EMPTY collection  */
/* (the loader defaults absent → `[]`), and a session that never rolled */
/* back serializes byte-identically (JSON.stringify drops the absent    */
/* fields). Each record carries its own `recordVersion` so a future     */
/* shape bump migrates forward; an UNKNOWN `recordVersion` or an        */
/* UNKNOWN operation `state` is fail-closed at load (the whole snapshot  */
/* is refused, never partially applied).                                */
/* ------------------------------------------------------------------ */

/** Current wire version for a single durable rollback record (checkpoint or
 *  operation). Bumped only on a shape change; the loader fail-closes on any
 *  other value so a forward-incompatible record can never be half-read. */
export const ROLLBACK_RECORD_VERSION = 1 as const

/** Closed lifecycle state of ONE rollback operation. `requested` is the
 *  durable intent written BEFORE the working-tree effect; `rolled_back` /
 *  `rollback_failed` are the terminal receipts written AFTER the effect (or
 *  its failure). No success state is ever written before the effect runs.
 *  A restart that finds a `requested` operation with no terminal record
 *  surfaces it as operator-visible recovery — it is NEVER assumed to have
 *  succeeded and is NEVER blind-retried. */
export type RollbackOperationState = "requested" | "rolled_back" | "rollback_failed"

/** A durable checkpoint MAPPING: which ShadowOdb ref/SHA a rollback target
 *  turn/message resolves to, plus the file hashes expected at that boundary.
 *  This is the ONLY persisted `messageId/turnId → ShadowOdb SHA` mapping —
 *  the effect side (`ThreeWayRestorePort`) never invents a target from a
 *  branch/path/PID name. `expectedFileHashes` lets the effect fail closed
 *  when the tree drifted from the recorded boundary. */
export interface RollbackCheckpointRecord {
  readonly recordVersion: typeof ROLLBACK_RECORD_VERSION
  /** Turn boundary this checkpoint anchors (stable turn id). */
  readonly turnId: string
  /** Transcript message id the checkpoint is keyed to (rewind target). */
  readonly messageId: string
  /** Content-addressed ShadowOdb ref/SHA captured at the boundary. The
   *  effect resolves THIS verbatim — no ordinal/branch/path guessing. */
  readonly checkpointSha: string
  /** Path → content-hash the tree is expected to carry at this boundary.
   *  Empty object means "no files tracked at capture" (still a valid,
   *  non-lossy record). Absent path ⇒ never widen the restore silently. */
  readonly expectedFileHashes: Readonly<Record<string, string>>
}

/** A durable rollback OPERATION receipt. `state` walks the closed lifecycle
 *  above; `operationId` is the idempotency key (a duplicate submit resolves
 *  to the existing terminal receipt, never a second effect). `errorCode` is
 *  present only on `rollback_failed`. */
export interface RollbackOperationRecord {
  readonly recordVersion: typeof ROLLBACK_RECORD_VERSION
  /** Idempotency key. Two records may share an id (intent + terminal) — the
   *  latest-by-`requestedAt`/terminal wins; see `rollback-record.ts`. */
  readonly operationId: string
  /** The turn this operation rolls back TO (matches a checkpoint's turnId). */
  readonly targetTurnId: string
  /** Closed lifecycle state — see {@link RollbackOperationState}. */
  readonly state: RollbackOperationState
  /** Epoch-ms the intent was recorded (injected clock at the coordinator). */
  readonly requestedAt: number
  /** Epoch-ms the terminal receipt was recorded. Absent while `requested`. */
  readonly terminalAt?: number
  /** Typed failure code on `rollback_failed`. Absent otherwise. */
  readonly errorCode?: string
}

export interface SavedSession {
  version: typeof SESSION_VERSION
  meta: SessionMeta
  reason: string
  turns: number
  messages: Message[]
  /** RFC-01 A2 — durable checkpoint mappings. Absent on legacy snapshots
   *  and on sessions that never captured a rollback checkpoint (⇒ the
   *  loader defaults to `[]`, and serialization is byte-identical). */
  rollbackCheckpoints?: RollbackCheckpointRecord[]
  /** RFC-01 A2 — durable rollback-operation receipts (intent + terminal).
   *  Absent on legacy snapshots and on sessions that never rolled back. */
  rollbackOperations?: RollbackOperationRecord[]
}

export interface SavePayload {
  reason: string
  turns: number
  messages: Message[]
  /** RFC-01 A2 — optional durable rollback records to persist alongside the
   *  transcript. Absent ⇒ the existing on-disk records are preserved
   *  as-is (a normal transcript save never drops rollback state). */
  rollbackCheckpoints?: RollbackCheckpointRecord[]
  rollbackOperations?: RollbackOperationRecord[]
}
