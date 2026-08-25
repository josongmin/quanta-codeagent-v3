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
  /* ----------------------------------------------------------------- */
  /* RFC-06 (aug-02 absorption) — persisted WorkspaceOwnership.         */
  /* The AUTHORITY for a user-session's isolated git worktree: which     */
  /* ownership id minted it, where it lives, which branch/base it forked */
  /* from, and its closed lifecycle state. This RIDES the existing       */
  /* atomic `SavedSession` snapshot (same file, same encoder) — there is */
  /* NO new binding/lease/TTL store and NO reaper. OPTIONAL: absent on   */
  /* every legacy transcript AND on non-worktree sessions ⇒ the          */
  /* (non-strict) `sessionMetaSchema` still validates and JSON.stringify */
  /* drops the absent field, so a session that never owned a worktree    */
  /* serializes byte-identically. path/branch are DISPLAY/convention —   */
  /* the `ownershipId` + persisted `path`/`branch` are the mutation      */
  /* target authority; NO cwd/path/branch-name inference reconstructs    */
  /* this. See docs/plans/aug-02-absorption/rfc-06-worktree-review-ux.md */
  /* §RFC06-0.                                                           */
  /* ----------------------------------------------------------------- */
  workspaceOwnership?: WorkspaceOwnership
}

/** RFC-06 §RFC06-0 — closed lifecycle of a persisted workspace worktree.
 *  `creating` is the durable INTENT written BEFORE the `git worktree add`
 *  effect; `ready`/`active` are published AFTER the effect succeeds;
 *  `closing`→`removed` is the teardown path; `failed`/`quarantined` are
 *  terminal error states. A restart that finds a `creating` record with no
 *  further transition surfaces it as operator-visible recovery — it is NEVER
 *  assumed ready and NEVER blind-adopted. An unknown wire value fail-closes
 *  the whole snapshot load (see `store.ts`). */
export type WorkspaceOwnershipState =
  | "creating"
  | "ready"
  | "active"
  | "closing"
  | "removed"
  | "failed"
  | "quarantined"

/** Current wire version for a persisted {@link WorkspaceOwnership} record.
 *  Bumped only on a shape change; the loader fail-closes on any other value
 *  so a forward-incompatible record can never be half-read (mirrors
 *  {@link ROLLBACK_RECORD_VERSION}). */
export const WORKSPACE_OWNERSHIP_VERSION = 1 as const

/** RFC-06 §RFC06-0 — the persisted authority for a user-session's isolated
 *  worktree. `ownershipId` is the explicit owner identity minted at create
 *  intent (NOT derived from a PID/path/branch name). `repoRoot`/`path`/`branch`
 *  are the exact mutation target — the hardened `removeWorktree` matches the
 *  porcelain-registered path against THIS `path` verbatim, never an inferred
 *  one. `baseSha` records the fork base so base-drift is detectable. `state`
 *  walks the closed lifecycle above. */
export interface WorkspaceOwnership {
  readonly recordVersion: typeof WORKSPACE_OWNERSHIP_VERSION
  /** Explicit owner identity minted at create intent. Authority — never
   *  derived from PID/path/branch name. */
  readonly ownershipId: string
  /** The thread that owns this worktree (create-intent origin). */
  readonly ownerThreadId: string
  /** Absolute repo root the worktree was added from (git dir owner). */
  readonly repoRoot: string
  /** Stable repo identity (e.g. origin url or repoRoot) for cross-session
   *  disambiguation. Convention only — not a mutation target. */
  readonly repoId: string
  /** Absolute worktree path. The EXACT mutation target: remove matches this
   *  against the porcelain-registered path verbatim. */
  readonly path: string
  /** Exact branch the worktree checked out. Branch deletion targets THIS
   *  verbatim after a successful remove — never a `fork-<segment>` guess. */
  readonly branch: string
  /** Fork base commit sha (base-drift detection). */
  readonly baseSha: string
  /** Closed lifecycle state — see {@link WorkspaceOwnershipState}. */
  readonly state: WorkspaceOwnershipState
  /** Epoch-ms the create intent was recorded (injected clock). */
  readonly createdAt: number
  /** Epoch-ms of the latest state transition (injected clock). */
  readonly updatedAt: number
  /** Typed error code on `failed`/`quarantined`. Absent otherwise. */
  readonly lastErrorCode?: string
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

/* ------------------------------------------------------------------ */
/* RFC-03 C2 — durable per-thread objective snapshot (aug-22 absorption).*/
/*                                                                      */
/* The objective authority (`@/objective`) is a leaf domain the         */
/* `@/session` slice may NOT value-import (`denyImports` includes        */
/* `@/objective`). So the session stores objective state as PLAIN JSON:  */
/* this DTO is a self-contained, structurally-mirrored data record — NO  */
/* behavior, NO import of the objective domain. The encode/restore       */
/* ADAPTER that maps between the live authority and this DTO lives in    */
/* the Layer-2 composition seam (`runner/assemble/session-authorities`), */
/* which MAY import `@/objective`. Session I/O only persists/reads the   */
/* DTO (a pure data blob).                                               */
/*                                                                      */
/* Schema evolution: `SavedSession.objective` is OPTIONAL. A legacy      */
/* snapshot minted before this field reads back as ABSENT (⇒ legacy/no   */
/* objective — NEVER an inferred default), and a session that never      */
/* carried an objective serializes byte-identically (JSON.stringify      */
/* drops the absent field). The `version` is a literal, so an UNKNOWN    */
/* version fail-closes the WHOLE snapshot load (never partially applied) */
/* — the same fail-closed migration contract as the rollback records.    */
/* ------------------------------------------------------------------ */

/** Current wire version for a persisted objective snapshot. Bumped only on a
 *  shape change; the loader fail-closes on any other value so a forward-
 *  incompatible record can never be half-read (mirrors the rollback records). */
export const OBJECTIVE_SNAPSHOT_VERSION = 1 as const

/** RFC-03 C4 — a persisted immutable check spec (mirrors `@/objective`
 *  `CheckSpec`). The `id` survives verbatim so a verifier receipt keeps binding
 *  to it across a reopen. Present only on a CHECKED criterion. */
export interface PersistedObjectiveCheckSpec {
  readonly id: string
  readonly kind: "command"
  readonly argv: readonly string[]
  readonly cwdPolicy: "thread"
  readonly timeoutMs: number
  readonly successExitCodes: readonly number[]
}

/** RFC-03 C4 — a persisted completion receipt (manual OR verifier evidence),
 *  mirroring `@/objective` `CompletionReceipt`. The `verifier` variant carries
 *  the full check id + objective revision + source digest + verifier result. */
export type PersistedObjectiveCompletion =
  | {
      readonly source: "manual"
      readonly actor: string
      readonly objectiveRevision: number
      readonly verifiedAt: number
    }
  | {
      readonly source: "verifier"
      readonly checkId: string
      readonly objectiveRevision: number
      readonly sourceDigest: string
      readonly verifierResult: { readonly exitCode: number; readonly passed: boolean }
      readonly verifiedAt: number
    }

/** A single persisted success criterion (mirrors `@/objective` `SuccessCriterion`
 *  structurally — ids survive the round-trip verbatim, never re-minted).
 *
 *  RFC-03 C4: `kind`/`check`/`completion` are OPTIONAL and ADDITIVE — a legacy
 *  record (no `kind`) decodes as a MANUAL criterion with no provenance (schema
 *  migration; the snapshot version does NOT bump). `kind:"checked"` carries an
 *  immutable `check`; `completion` is the evidence receipt present only when met.
 *  Omitted for a plain manual criterion so serialization stays byte-identical to
 *  the pre-C4 `{ id, text, met }` shape. */
export interface PersistedObjectiveCriterion {
  readonly id: string
  readonly text: string
  readonly met: boolean
  readonly kind?: "manual" | "checked"
  readonly check?: PersistedObjectiveCheckSpec
  readonly completion?: PersistedObjectiveCompletion
}

/** A single persisted blocker (mirrors `@/objective` `Blocker` structurally). */
export interface PersistedObjectiveBlocker {
  readonly id: string
  readonly reason: string
  readonly waitingOn: string
  readonly since: number
}

/** Persisted budget envelope (mirrors `@/objective` `ObjectiveBudget`). */
export interface PersistedObjectiveBudget {
  readonly maxTokens?: number
  readonly tokensUsed: number
  readonly maxTurns?: number
  readonly turnsUsed: number
}

/** Bounded, digest/reference-only objective turn checkpoint. */
export interface PersistedProgressReceipt {
  readonly attemptKey: string
  readonly objectiveRevisionBefore: number
  readonly objectiveRevisionAfter: number
  readonly turnOutcome: "completed" | "aborted" | "error" | "backgrounded"
  readonly criterionTransitions: readonly string[]
  readonly verifierReceiptRefs: readonly string[]
  readonly sourceDigest?: string
  readonly remainingCriterionIds: readonly string[]
  readonly recordedAt: number
}

/** The full serializable state of ONE thread's objective + its per-thread
 *  authority revision + the persisted EXPLICIT status intent (provenance). The
 *  derived public `status` is stored for readability, but the authoritative
 *  restore source for status is `explicitStatus` (re-derivation stays a pure
 *  function of explicitStatus + criteria + blockers on the objective side). */
export interface PersistedObjectiveThread {
  readonly threadId: string
  /** The per-thread mutation-authority revision at snapshot time (RFC-03 C1).
   *  Restored verbatim so CAS/undo bookkeeping survives a reopen. */
  readonly revision: number
  readonly goal: string
  readonly successCriteria: readonly PersistedObjectiveCriterion[]
  /** Derived status at snapshot time (advisory; `explicitStatus` is the restore
   *  source of truth for the caller's intent). */
  readonly status: string
  /** The caller's last EXPLICIT status intent — the ONLY status source on
   *  restore (never inferred from the derived `status`). */
  readonly explicitStatus: "active" | "paused" | "completed"
  /** Transient usage-window expiry (epoch ms); omitted when no window is set. */
  readonly usageLimitedUntil?: number
  readonly budget: PersistedObjectiveBudget
  readonly blockers: readonly PersistedObjectiveBlocker[]
  readonly nextActions: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly progressReceipts?: readonly PersistedProgressReceipt[]
}

/** The durable objective snapshot persisted on a {@link SavedSession}: every
 *  live thread's full state + revision + provenance. Plain data — the session
 *  slice never imports the objective domain to produce/consume it. */
export interface PersistedObjectiveSnapshot {
  readonly version: typeof OBJECTIVE_SNAPSHOT_VERSION
  readonly threads: readonly PersistedObjectiveThread[]
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
  /** RFC-03 C2 — durable per-thread objective snapshot. Absent on legacy
   *  snapshots and on sessions with no objective ⇒ serialization is
   *  byte-identical; absence means legacy/no objective, never an inferred
   *  default. Produced/consumed by the Layer-2 objective encode/restore
   *  adapter (session stores the JSON only). */
  objective?: PersistedObjectiveSnapshot
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
  /** RFC-03 C2 — optional durable objective snapshot to persist alongside the
   *  transcript. Absent ⇒ the existing on-disk objective is preserved as-is (a
   *  normal transcript save never drops objective state — same discipline as
   *  the rollback ledger). */
  objective?: PersistedObjectiveSnapshot
}
