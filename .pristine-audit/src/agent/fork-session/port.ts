/**
 * SessionForker + ForkSessionPort ports (ADR-0201 + ADR-0226).
 *
 * Closed-port DI seams. Two ports live here:
 *
 *   1. `SessionForker` (ADR-0201) — the BASE port. Synchronous
 *      `Result`-returning surface over a `ConversationCheckpointStore`.
 *      Consumed by the `fork_session` agent tool (no branch labels,
 *      no signal, no shadow ODB).
 *
 *   2. `ForkSessionPort` (ADR-0226) — the RICH port. Asynchronous,
 *      signal-cancelable, accepts an optional `branchName`, writes a
 *      `fork-tag` to the shadow ODB (when wired), and records
 *      parent-link metadata so `listBranches` / `resolveParent` can
 *      answer. This is what the new `/fork` slash command + future
 *      surfaces (e.g. a branch-tree visualiser) consume. The default-
 *      impl (`./default-forker.ts` `defaultForker`) composes a
 *      `SessionForker`, a `ParentLinkStore`, an optional `ShadowOdbLike`
 *      adapter, and a branch-id minter.
 *
 * Plane-clean: imports only `@/shared` for `Result` + sibling types.
 * No `@/agent/loop`, no `@/agent/dispatch`, no direct `@/storage/shadow-odb`.
 */

import type { Result } from "@/shared"
import type { ParentLink } from "./parent-link"
import type { ForkError, ForkedSessionHandle } from "./types"

export interface SessionForker {
  /** Fork a new session from the snapshot recorded under `checkpointId`. The
   *  snapshot is reused verbatim (immutable, shared) and registered under a
   *  freshly-minted `sessionId` (UUID v4). Lineage is recorded so the parent
   *  can be recovered via `ConversationCheckpointStore.lineageOf`. */
  fork(checkpointId: string): Result<ForkedSessionHandle, ForkError>
}

/* ============================================================
 * ADR-0226 — ForkSessionPort (richer surface, async + signal)
 * ============================================================ */

/** Input to `ForkSessionPort.fork`. `branchName` + `signal` are optional;
 *  consumers that don't care pass `{ fromCheckpointRef }`.
 *  exactOptionalPropertyTypes — optional fields are absent, never `undefined`. */
export interface ForkInput {
  /** Conversation checkpoint id to fork from. Required. */
  readonly fromCheckpointRef: string
  /** Optional human label for the branch. When present, MUST be
   *  well-formed (URL-safe, <= 64 chars, no `..`) — caller bug otherwise
   *  surfaces as `Err("invalid-branch-name")`. */
  readonly branchName?: string
  /** Optional `AbortSignal`. When triggered BEFORE shadow-ODB write,
   *  surfaces as `Err("aborted")` and NO state mutates (no clone, no
   *  link, no tag). Already-aborted at call ⇒ same. */
  readonly signal?: AbortSignal
}

/** Success payload returned by `ForkSessionPort.fork`. Wraps the original
 *  `ForkedSessionHandle` with the richer ADR-0226 fields (`branchId`,
 *  `branchName`, `branchPoint`). */
export interface ForkResult {
  /** New session id minted by the underlying `SessionForker`. UUID v4. */
  readonly newSessionId: string
  /** Parent session id (== the source checkpoint id in v1). */
  readonly parentSessionId: string
  /** Branch point — same as `parentSessionId` today; reserved for a
   *  future per-session multi-checkpoint axis. */
  readonly branchPoint: string
  /** Fresh URL-safe branch id (21 chars, ~126 bits entropy). Distinct
   *  from `newSessionId` (sessions are UUID v4, branches are nanoid-shape). */
  readonly branchId: string
  /** Echo of the caller's `branchName` when supplied — absent (NOT
   *  `undefined`) otherwise so `exactOptionalPropertyTypes` stays clean. */
  readonly branchName?: string
  /** Epoch-ms fork timestamp. */
  readonly forkedAt: number
  /** Frozen messages array shared with the parent snapshot. */
  readonly messages: ReadonlyArray<unknown>
}

/** One branch surface row, surfaced by `listBranches`. Mirrors `ParentLink`
 *  shape but uses the public `ForkResult`-aligned names so callers don't
 *  reach into the internal store. */
export interface BranchInfo extends ParentLink {}

export interface ForkSessionPort {
  /** Fork a new session from `fromCheckpointRef`. Optionally tag the
   *  resulting branch with `branchName`. Honours `signal` — an
   *  already-aborted signal short-circuits to `Err("aborted")` BEFORE
   *  any state mutates. The shadow ODB (when wired) records a
   *  branch-tag at the current workspace head so a future restore can
   *  navigate back. */
  fork(input: ForkInput): Promise<Result<ForkResult, ForkError>>
  /** Enumerate every direct child branch of `sessionId`, NEWEST-FIRST.
   *  Empty array when none. NEVER throws (unknown ids → `[]`). */
  listBranches(input: { readonly sessionId: string }): ReadonlyArray<BranchInfo>
  /** Walk up one level. Returns the parent session id, or `null` for
   *  a root / unknown id. */
  resolveParent(input: { readonly sessionId: string }): string | null
}
