/**
 * RFC-03 C1 — objective mutation authority port surface.
 *
 * The authority is the SINGLE writer of the objective domain. It exposes:
 *   - the `ObjectivePort` surface (the SYSTEM-actor capability every existing
 *     caller routes through — no direct store call remains), plus
 *   - the revisioned `prepare` / `commit` / `restore` protocol with a bound
 *     actor/thread command, per-domain revision and CAS.
 *
 * `prepare` validates the bound thread identity, actor, operation kind, expected
 * revision and policy WITHOUT mutating state, and returns the immutable prior
 * snapshot. `commit` re-checks CAS against the prepared revision and applies the
 * effect; a concurrent writer that prepared at the same revision is rejected
 * `stale`. Approval waiting happens OUTSIDE the authority (no store lock is held
 * across an await) — the caller obtains an `ApprovalReceipt` and passes it to
 * `commit`.
 *
 * GOAL-01: consumers that only READ receive {@link ObjectiveReadPort}; the raw
 * authority stays at the composition root (the boundary ratchet in
 * `tests/unit/objective/authority-boundary-ratchet.test.ts` pins its call sites).
 *
 * SLICE FENCE: imports ONLY sibling `./types` / `./model` / `./mutations`.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ObjectiveIdFactory } from "./identity"
import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveActor, ObjectiveMutation } from "./mutations"
import type { ProgressReceipt } from "./progress-receipt"
import type { Objective, ObjectivePort } from "./types"

/**
 * A bound mutation command. `threadId` and `actor` are supplied by the
 * CALLER/session — RFC-03 §8 forbids sourcing thread identity from model input.
 * `expectedRevision` is optional: when omitted, `prepare` binds the current
 * revision (an atomic caller); when present, it pins an explicit CAS target (a
 * multi-surface edit that read an older revision).
 */
export interface ObjectiveMutationCommand {
  readonly threadId: string
  readonly actor: ObjectiveActor
  readonly mutation: ObjectiveMutation
  readonly expectedRevision?: number | undefined
}

/**
 * The result of `prepare`: the validated command bound to a concrete revision +
 * the immutable prior snapshot (for undo) + whether an admitted approval is
 * required before `commit` will apply the effect.
 */
export interface PreparedObjectiveMutation {
  readonly command: ObjectiveMutationCommand
  readonly expectedRevision: number
  readonly prior: ObjectiveDomainSnapshot
  readonly approvalRequired: boolean
}

/**
 * An approval outcome for a gated mutation. `admitted:true` is the ONLY thing
 * that lets a policy-gated model mutation commit; the authority never fabricates
 * one. A non-gated (system/user/verifier or gate-OFF) commit ignores it.
 */
export interface ApprovalReceipt {
  readonly admitted: boolean
  readonly note?: string | undefined
}

/** Why a commit did not apply. Every code is stable and typed; surfaces render
 *  it but never re-implement the policy that produced it. */
export type CommitRejection =
  /** CAS: the domain revision moved past the prepared `expectedRevision`. */
  | "stale"
  /** Policy required an admitted approval and none was supplied. */
  | "approval-required"
  /** Gate ON but the caller declared no confirmation capability (fail-closed). */
  | "approval-unavailable"
  /** A model actor tried to COMPLETE a criterion — the authority owns completion. */
  | "forbidden-completion"
  /** RFC-03 C4 — a non-verifier actor tried to `markCriterion(met:true)` on a
   *  CHECKED criterion. Structural (independent of the propose gate). */
  | "checked-verifier-only"
  /** GOAL-01 — `create` while an objective is live on the thread. */
  | "objective-exists"
  /** GOAL-01 — `replace` / `clear` / a settlement with no live objective. */
  | "objective-missing"
  /** GOAL-01 — evidence bound to a generation that is not the live one. */
  | "objective-mismatch"
  /** GOAL-01 — a settlement whose `attemptId` was already settled. */
  | "attempt-replayed"
  /** GOAL-01 — the goal text exceeds the domain ceiling (`MAX_GOAL_CHARS`). */
  | "goal-too-long"
  /** The bound actor may not issue this mutation kind. */
  | "actor-forbidden"
  /** GOAL-02 — an explicit status change the transition table forbids. */
  | "invalid-transition"
  /** GOAL-02 — a model mutation against a completed objective. */
  | "terminal-objective"
  /** GOAL-02 — an autonomous actor tried to change the user-owned definition. */
  | "definition-change-forbidden"
  /** GOAL-02 — a manual criterion needs a user/system attestation. */
  | "manual-attestation-required"
  /** GOAL-02 — an objective without a stopping contract cannot progress here. */
  | "validation-contract-missing"
  /** GOAL-02/04 — a definition change while a durable attempt is unsettled. */
  | "attempt-in-flight"
  /** Malformed command / unknown thread for a non-generation op. */
  | "invalid"

export type CommitResult =
  | { readonly ok: true; readonly revision: number; readonly snapshot: ObjectiveDomainSnapshot }
  | { readonly ok: false; readonly reason: CommitRejection; readonly currentRevision: number }

/** GOAL-01 — the READ-ONLY capability ordinary consumers receive. */
export interface ObjectiveReadPort {
  get(threadId: string): Objective | null
  list(): readonly Objective[]
  /** Current per-thread domain snapshot (revision + immutable state). */
  readDomain(threadId: string): ObjectiveDomainSnapshot
}

/**
 * The revisioned objective authority. Extends `ObjectivePort` so every legacy
 * caller (tools, approval-state-machine attribution, `/goal`, continuation,
 * usage-limit wire) routes through it unchanged; those surface methods commit as
 * a trusted `system` actor with atomic CAS. The `prepare`/`commit`/`restore`
 * protocol is the model/CLI/verifier front door with explicit actor + revision.
 */
export interface ObjectiveAuthority extends ObjectivePort, ObjectiveReadPort {
  /** Validate + bind a command to a revision WITHOUT mutating state. */
  prepare(command: ObjectiveMutationCommand): PreparedObjectiveMutation
  /** Apply a prepared mutation under CAS with an approval receipt. */
  commit(prepared: PreparedObjectiveMutation, approval: ApprovalReceipt): CommitResult
  /** Exact undo: restore a prior domain snapshot under CAS. */
  restore(previous: ObjectiveDomainSnapshot, expectedRevision: number): CommitResult
  /**
   * RFC-03 C2 (web parity) — LIVE, post-construction restore of ONE persisted
   * per-thread {@link ObjectiveDomainSnapshot}, planting its state VERBATIM and
   * preserving its EXACT revision (the per-thread parallel of the construction
   * `restoreDomains` seam, NOT the `restore`/mutation path which bumps the
   * revision). A `state: null` snapshot with a positive revision plants a
   * TOMBSTONE (revision only). Returns `false` (nothing planted) for a malformed
   * snapshot; the caller owns the no-clobber policy. Unlike `restore` there is
   * NO CAS check — it is a durable-resume load, not an undo.
   */
  restoreDomain(snapshot: ObjectiveDomainSnapshot): boolean
  /** Append a validated bounded turn-evidence packet without changing objective
   *  revision. The packet's `objectiveId` must be the live generation. */
  recordProgressReceipt(threadId: string, receipt: ProgressReceipt): boolean
  /** Every thread the authority knows — live objectives AND tombstones. */
  knownThreadIds(): readonly string[]
}

/**
 * Construction options for the authority.
 *   - `now` — injected clock seam (default `Date.now`).
 *   - `idFactory` — objective generation id minter (default `crypto.randomUUID`).
 *   - `enforceBudget` — H17 budget/usage derivation (forwarded to the core store).
 *   - `gateOn` — RFC-03 `QUANTA_PROPOSE_GOAL` posture. OFF (default) ⇒ model
 *     mutations commit without approval. ON ⇒ model create/replace/completion
 *     changes require an admitted approval and a model may NOT complete a
 *     criterion. (GOAL-02 replaces this with the exhaustive policy table.)
 *   - `confirmationAvailable` — whether the surface can raise an approval dialog.
 *     Under `gateOn`, a gated model mutation with NO confirmation capability is
 *     `approval-unavailable` (fail-closed), never an approval bypass.
 */
export interface ObjectiveAuthorityOptions {
  now?: (() => number) | undefined
  idFactory?: ObjectiveIdFactory | undefined
  enforceBudget?: boolean | undefined
  gateOn?: boolean | undefined
  confirmationAvailable?: boolean | undefined
  /**
   * RFC-03 C2 — restore-at-construction seam. When present, each per-thread
   * {@link ObjectiveDomainSnapshot} is loaded into the fresh authority as part of
   * CONSTRUCTION: the thread's exact state is written back verbatim (ids / met /
   * ordering / blockers / next actions / provenance / status intent) AND its
   * per-thread `revision` is restored to the persisted value — including a
   * `state: null` TOMBSTONE. This is the durable-resume entry point (session
   * identity → saved objective → authority construction). Absent ⇒ a fresh empty
   * authority (byte-identical legacy). A malformed snapshot is skipped.
   */
  restoreDomains?: readonly ObjectiveDomainSnapshot[] | undefined
}
