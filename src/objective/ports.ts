/**
 * RFC-03 C1 — objective mutation authority port surface.
 *
 * The authority is the SINGLE writer of the objective domain. It exposes:
 *   - the legacy `ObjectivePort` surface (so every existing caller routes
 *     through it unchanged — no direct store call remains), plus
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
 * SLICE FENCE: imports ONLY sibling `./types` / `./model` / `./mutations`.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveActor, ObjectiveMutation } from "./mutations"
import type { ObjectivePort } from "./types"

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

/** Why a commit did not apply. */
export type CommitRejection =
  /** CAS: the domain revision moved past the prepared `expectedRevision`. */
  | "stale"
  /** Policy required an admitted approval and none was supplied. */
  | "approval-required"
  /** Gate ON but the caller declared no confirmation capability (fail-closed). */
  | "approval-unavailable"
  /** A model actor tried to COMPLETE a criterion — the authority owns completion. */
  | "forbidden-completion"
  /** Malformed command / unknown thread for a non-`set` op. */
  | "invalid"

export type CommitResult =
  | { readonly ok: true; readonly revision: number; readonly snapshot: ObjectiveDomainSnapshot }
  | { readonly ok: false; readonly reason: CommitRejection; readonly currentRevision: number }

/**
 * The revisioned objective authority. Extends `ObjectivePort` so every legacy
 * caller (tools, approval-state-machine attribution, `/goal`, continuation,
 * usage-limit wire) routes through it unchanged; those surface methods commit as
 * a trusted `system` actor with atomic CAS. The `prepare`/`commit`/`restore`
 * protocol is the model/CLI/verifier front door with explicit actor + revision.
 */
export interface ObjectiveAuthority extends ObjectivePort {
  /** Current per-thread domain snapshot (revision + immutable state). */
  readDomain(threadId: string): ObjectiveDomainSnapshot
  /** Validate + bind a command to a revision WITHOUT mutating state. */
  prepare(command: ObjectiveMutationCommand): PreparedObjectiveMutation
  /** Apply a prepared mutation under CAS with an approval receipt. */
  commit(prepared: PreparedObjectiveMutation, approval: ApprovalReceipt): CommitResult
  /** Exact undo: restore a prior domain snapshot under CAS. */
  restore(previous: ObjectiveDomainSnapshot, expectedRevision: number): CommitResult
}

/**
 * Construction options for the authority.
 *   - `now` — injected clock seam (default `Date.now`).
 *   - `enforceBudget` — H17 budget/usage derivation (forwarded to the core store).
 *   - `gateOn` — RFC-03 `QUANTA_PROPOSE_GOAL` posture. OFF (default) ⇒ byte-
 *     identical legacy: model mutations commit without approval and a model may
 *     self-mark criteria. ON ⇒ model set/replace/completion changes require an
 *     admitted approval and a model may NOT complete a criterion.
 *   - `confirmationAvailable` — whether the surface can raise an approval dialog.
 *     Under `gateOn`, a gated model mutation with NO confirmation capability is
 *     `approval-unavailable` (fail-closed), never an approval bypass.
 */
export interface ObjectiveAuthorityOptions {
  now?: (() => number) | undefined
  enforceBudget?: boolean | undefined
  gateOn?: boolean | undefined
  confirmationAvailable?: boolean | undefined
}
