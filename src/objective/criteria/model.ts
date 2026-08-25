/**
 * RFC-03 C4 — criterion declaration vs. completion EVIDENCE.
 *
 * A success criterion separates what it means to be done (the DECLARATION) from
 * proof it IS done (the EVIDENCE / receipt):
 *
 *   - a `manual` criterion is completed by an explicit ACTOR attestation
 *     (advisory — a user/system says so; not machine-proof); and
 *   - a `checked` criterion declares an IMMUTABLE {@link CheckSpec} and can be
 *     completed ONLY by a verifier receipt carrying the check identity, the
 *     objective generation + revision, a source digest and the verifier result.
 *
 * The forgery invariant (RFC-03 §8 stop rule) lives in the TYPES: a
 * {@link VerifierCompletionReceipt} has no constructor reachable from a
 * model/tool input schema — the tool adapter can DECLARE a {@link CheckSpec}
 * (argv/timeout/exit-codes) but never mint an `id`, a `cwdPolicy`, or a receipt.
 * The check `id` and `cwdPolicy` are domain-minted at creation, so a receipt can
 * only reference an id the domain issued.
 *
 * GOAL-01: every receipt carries the `objectiveId` generation it was minted
 * against; the authority refuses a receipt whose generation is not live.
 *
 * SLICE FENCE: imports ONLY the sibling provenance type. Pure data.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ObjectiveActor } from "../provenance"

/** Which family a success criterion belongs to. */
export type CriterionKind = "manual" | "checked"

/**
 * A model/tool-DECLARABLE machine check. This is the payload a proposer may
 * supply (argv + timeout + success exit codes). It carries NO identity and NO
 * cwd policy — both are domain-minted at criterion creation so the model cannot
 * choose them (and a receipt can only bind to a domain-issued id).
 */
export interface CheckSpecDeclaration {
  readonly kind: "command"
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly successExitCodes: readonly number[]
}

/**
 * The IMMUTABLE stored check spec: the declaration plus the domain-minted `id`
 * and the fixed `cwdPolicy`. Once a checked criterion is created its `check`
 * never mutates (no mutation touches it; a `replace` mints a fresh criterion
 * with a fresh id). Stored frozen.
 */
export interface CheckSpec extends CheckSpecDeclaration {
  /** Domain-minted identity — a verifier receipt MUST match this exactly. */
  readonly id: string
  /** Fixed by the domain (never model-supplied); the check runs in the thread cwd. */
  readonly cwdPolicy: "thread"
}

/**
 * RFC-03 C4 — a declared success criterion in a definition. A bare string is
 * still accepted elsewhere (⇒ a manual criterion); this object form may carry a
 * `check` declaration (⇒ a checked, verifier-only criterion). The check
 * `id`/`cwdPolicy` are domain-minted, never part of the declaration.
 */
export interface CriterionDeclaration {
  readonly text: string
  readonly check?: CheckSpecDeclaration | undefined
}

/** The outcome of running a check: an exit code and the derived pass verdict
 *  (`0`-family exit ⇒ pass; anything else ⇒ NOT pass — abstain, never complete). */
export interface VerifierResult {
  readonly exitCode: number
  readonly passed: boolean
}

/**
 * Evidence that a MANUAL criterion was completed: an explicit actor attestation
 * bound to the objective generation + revision at attestation time. Advisory (a
 * user/system asserting completion), never machine-proof. Minted by the
 * AUTHORITY (which holds the bound actor + revision + clock) — never from a
 * model/tool payload.
 */
export interface ManualCompletionReceipt {
  readonly source: "manual"
  /** The objective generation this attestation was recorded against. */
  readonly objectiveId: string
  /** The bound actor that attested completion (from the session, not model input). */
  readonly actor: ObjectiveActor
  /** The objective revision this attestation was recorded against. */
  readonly objectiveRevision: number
  /** Clock-stamped attestation time (epoch ms). */
  readonly verifiedAt: number
}

/**
 * Evidence that a CHECKED criterion was completed: the ONLY thing that can flip a
 * checked criterion to met. Every field is REQUIRED (RFC-03 §receipt): the check
 * identity that ran, the objective generation + revision it was verified
 * against, the source digest of the workspace at verification time, and the
 * verifier result.
 */
export interface VerifierCompletionReceipt {
  readonly source: "verifier"
  /** The objective generation this result was verified against. */
  readonly objectiveId: string
  /** Identity of the {@link CheckSpec} that produced this result. */
  readonly checkId: string
  /** The objective revision this result was verified against (CAS-bound). */
  readonly objectiveRevision: number
  /** Digest of the workspace/source state at verification time (non-empty). */
  readonly sourceDigest: string
  /** The verifier result (exit code + pass verdict). */
  readonly verifierResult: VerifierResult
  /** Clock-stamped verification time (epoch ms). */
  readonly verifiedAt: number
}

/** The closed completion-evidence union. A `manual` criterion carries a manual
 *  receipt; a `checked` criterion carries a verifier receipt. */
export type CompletionReceipt = ManualCompletionReceipt | VerifierCompletionReceipt

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** True iff a value is a well-formed {@link VerifierCompletionReceipt}. Used by
 *  the authority to reject a malformed/forged receipt before it can complete a
 *  checked criterion. Every required field is checked (no placeholder). */
export const isVerifierReceipt = (v: unknown): v is VerifierCompletionReceipt => {
  if (v === null || typeof v !== "object") return false
  const r = v as Partial<VerifierCompletionReceipt>
  return (
    r.source === "verifier" &&
    isNonEmptyString(r.objectiveId) &&
    isNonEmptyString(r.checkId) &&
    typeof r.objectiveRevision === "number" &&
    Number.isFinite(r.objectiveRevision) &&
    isNonEmptyString(r.sourceDigest) &&
    r.verifierResult !== undefined &&
    r.verifierResult !== null &&
    typeof r.verifierResult.exitCode === "number" &&
    typeof r.verifierResult.passed === "boolean" &&
    typeof r.verifiedAt === "number" &&
    Number.isFinite(r.verifiedAt)
  )
}

/** True iff a value is a well-formed {@link ManualCompletionReceipt}. */
export const isManualReceipt = (v: unknown): v is ManualCompletionReceipt => {
  if (v === null || typeof v !== "object") return false
  const r = v as Partial<ManualCompletionReceipt>
  return (
    r.source === "manual" &&
    isNonEmptyString(r.objectiveId) &&
    isNonEmptyString(r.actor) &&
    typeof r.objectiveRevision === "number" &&
    Number.isFinite(r.objectiveRevision) &&
    typeof r.verifiedAt === "number" &&
    Number.isFinite(r.verifiedAt)
  )
}

/** Coerce a (possibly hostile) declaration into a normalized {@link CheckSpecDeclaration}
 *  or `null` when it is not a runnable command check. Pure — no id/cwd minting. */
export const normalizeCheckDeclaration = (v: unknown): CheckSpecDeclaration | null => {
  if (v === null || typeof v !== "object") return null
  const d = v as Partial<CheckSpecDeclaration>
  if (d.kind !== "command") return null
  if (!Array.isArray(d.argv) || d.argv.some((a) => typeof a !== "string")) return null
  if (typeof d.timeoutMs !== "number" || !Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0) {
    return null
  }
  if (
    !Array.isArray(d.successExitCodes) ||
    d.successExitCodes.some((c) => typeof c !== "number" || !Number.isFinite(c))
  ) {
    return null
  }
  return {
    kind: "command",
    argv: [...d.argv],
    timeoutMs: Math.floor(d.timeoutMs),
    successExitCodes: [...d.successExitCodes],
  }
}
