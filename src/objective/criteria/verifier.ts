/**
 * RFC-03 C4 — the VERIFIER completion port + the (unsupported) execution seam.
 *
 * The verifier is the ONLY transition owner for a checked criterion: it mints a
 * {@link VerifierCompletionReceipt} from a real {@link VerifierResult} + a source
 * digest and drives it through the objective AUTHORITY as a `verifier`-actor
 * `markCriterionVerified` mutation. Because:
 *
 *   - no tool input schema maps to the `markCriterionVerified` mutation kind, and
 *   - the authority admits that mutation ONLY for a `verifier` actor, and
 *   - the actor is bound by the CALLER (never model input),
 *
 * a model/tool payload can NEVER mint a placeholder receipt (RFC-03 §8 stop
 * rule). The receipt is additionally re-validated inside the authority against
 * the declared check identity, the objective generation + revision, and the pass
 * verdict.
 *
 * The EXECUTION port ({@link CheckExecutionPort}) — which would actually run a
 * check to PRODUCE a {@link VerifierResult} — is C5 (PARKED until GOAL-03): it is
 * a typed-but-UNSUPPORTED seam here. The default {@link unsupportedCheckExecutionPort}
 * rejects every call.
 *
 * SLICE FENCE: imports ONLY sibling objective modules. Pure leaf.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ObjectiveAuthority } from "../ports"
import type { CheckSpec, VerifierCompletionReceipt, VerifierResult } from "./model"

/** Context handed to a check execution (C5): the thread it runs against and the
 *  source digest captured at execution time (used to CAS the completion). */
export interface CheckExecutionContext {
  readonly threadId: string
  readonly sourceDigest: string
}

/**
 * The execution seam that would RUN a {@link CheckSpec} and return its result.
 * C5 (PARKED): no production implementation exists in C4. GOAL-03 supplies the
 * read-only argv runner; until then the default is {@link unsupportedCheckExecutionPort}.
 */
export interface CheckExecutionPort {
  execute(spec: CheckSpec, ctx: CheckExecutionContext): Promise<VerifierResult>
}

/** The message a call to the unsupported execution port rejects with. */
export const UNSUPPORTED_CHECK_EXECUTION = "objective check execution is unsupported (C5 PARKED)"

/** The default execution port: a typed-but-UNSUPPORTED seam. Every call rejects
 *  — C4 implements the verifier TRANSITION, not process execution. */
export const unsupportedCheckExecutionPort: CheckExecutionPort = {
  execute(): Promise<VerifierResult> {
    return Promise.reject(new Error(UNSUPPORTED_CHECK_EXECUTION))
  },
}

/** Input to a verifier completion: the checked criterion identity, the check id
 *  that ran, the source digest at verification time, and the produced result.
 *  `expectedRevision` pins CAS when the caller read an older revision. */
export interface VerifierCompletionInput {
  readonly threadId: string
  readonly criterionId: string
  readonly checkId: string
  readonly sourceDigest: string
  readonly result: VerifierResult
  readonly expectedRevision?: number | undefined
}

/** The verifier completion port — the checked-criterion transition owner. */
export interface VerifierCompletionPort {
  complete(input: VerifierCompletionInput): ReturnType<ObjectiveAuthority["commit"]>
}

/**
 * Build a {@link VerifierCompletionPort} over an objective {@link ObjectiveAuthority}.
 * It mints the receipt (source digest + result + objective generation/revision +
 * clock) and commits it as a `verifier`-actor `markCriterionVerified` mutation
 * under CAS. The authority re-validates the receipt (check id / generation /
 * revision / pass verdict), so a mismatched or non-passing result is refused
 * (`ok:false`) and never completes.
 */
export const createVerifierCompletion = (
  authority: ObjectiveAuthority,
  opts?: { now?: (() => number) | undefined },
): VerifierCompletionPort => {
  const now = opts?.now ?? Date.now
  return {
    complete(input) {
      const domain = authority.readDomain(input.threadId)
      const revision = input.expectedRevision ?? domain.revision
      const receipt: VerifierCompletionReceipt = {
        source: "verifier",
        objectiveId: domain.state?.objective.objectiveId ?? "",
        checkId: input.checkId,
        objectiveRevision: revision,
        sourceDigest: input.sourceDigest,
        verifierResult: input.result,
        verifiedAt: now(),
      }
      const prepared = authority.prepare({
        threadId: input.threadId,
        actor: "verifier",
        mutation: { kind: "markCriterionVerified", criterionId: input.criterionId, receipt },
        expectedRevision: revision,
      })
      return authority.commit(prepared, { admitted: true })
    },
  }
}
