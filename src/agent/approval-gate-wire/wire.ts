/**
 * ADR-0407 — Approval-gate wire (adapter factory).
 *
 * The ONLY mutator in this slice. Wraps an `ApprovalStateMachinePort.request`
 * + `settle` pair around a host-supplied HITL resolver. Behavior matrix:
 *
 *   | approvalSM | resolver behavior     | gate behavior                       |
 *   |------------|-----------------------|--------------------------------------|
 *   | undefined  | resolves any decision | legacy passthrough, approvalId=""    |
 *   | undefined  | throws                | rethrow, no SM calls                 |
 *   | present    | resolves "approve"    | request + settle("approve"), id set  |
 *   | present    | resolves "deny"       | request + settle("deny"),    id set  |
 *   | present    | resolves "modify"     | request + settle("modify",{mod})     |
 *   | present    | throws                | settle("deny") best-effort + rethrow |
 *   | request()  throws                  | resolver still runs, approvalId=""   |
 *   | settle()   throws                  | resolution still returned            |
 *
 * Slice fence: imports = `@/agent/approval-state-machine` (TYPES ONLY) + the
 * sibling `./types`. NO admissibility-gate, NO loop, NO dispatch, NO agent
 * types, NO apps.
 */

import type { ApprovalDecision } from "@/agent/approval-state-machine"
import type {
  ApprovalGateDeps,
  ApprovalGatePort,
  ApprovalGateRequest,
  ApprovalGateResolution,
  ApprovalGateResolver,
  ApprovalGateResolverReturn,
} from "./types"

const isString = (v: unknown): v is string => typeof v === "string"

/** A deferred runtime approval has already been accepted by the kernel-facing
 * protocol. It is not a resolver failure or a deny: preserve it as pending
 * under the approval id the kernel will later send to `approval.respond`. */
const kernelApprovalIdOf = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") return undefined
  const candidate = error as { name?: unknown; approval?: { approvalId?: unknown } }
  if (candidate.name !== "RuntimeApprovalRequiredError") return undefined
  const approvalId = candidate.approval?.approvalId
  return isString(approvalId) && approvalId.length > 0 ? approvalId : undefined
}

/** Normalize a resolver return into a `{ decision, modifiedAction? }` tuple.
 *  A bare string is treated as a decision; an object form forwards
 *  `modifiedAction` only when the decision is "modify" — defensive, mirrors
 *  the SM's own settle() shape. */
const normalizeResolverReturn = (
  raw: ApprovalGateResolverReturn,
): { decision: ApprovalDecision; modifiedAction?: string } => {
  if (isString(raw)) return { decision: raw }
  if (raw && typeof raw === "object" && "decision" in raw) {
    const dec = (raw as { decision: ApprovalDecision }).decision
    const mod = (raw as { modifiedAction?: unknown }).modifiedAction
    if (dec === "modify" && isString(mod)) {
      return { decision: dec, modifiedAction: mod }
    }
    return { decision: dec }
  }
  // Hostile / malformed — default to "deny" (NO-THROW contract).
  return { decision: "deny" }
}

/** Best-effort SM.settle — swallows throws so a hostile / misbehaving SM
 *  cannot break the gate's own contract. */
const safeSettle = (
  deps: ApprovalGateDeps,
  approvalId: string,
  decision: ApprovalDecision,
  modifiedAction?: string,
): void => {
  if (deps.approvalSM === undefined || approvalId.length === 0) return
  try {
    if (modifiedAction !== undefined) {
      deps.approvalSM.settle(approvalId, decision, { modifiedAction })
    } else {
      deps.approvalSM.settle(approvalId, decision)
    }
  } catch {
    // SM failure must not propagate past the gate boundary.
  }
}

/** Best-effort SM.request — returns the minted id, or "" on failure. */
const safeRequest = (
  deps: ApprovalGateDeps,
  req: ApprovalGateRequest,
  kernelApprovalId?: string,
): string => {
  if (deps.approvalSM === undefined) return ""
  try {
    const built = deps.approvalSM.request({
      ...(kernelApprovalId !== undefined ? { id: kernelApprovalId } : {}),
      threadId: req.threadId,
      kind: req.kind,
      reason: req.reason,
      proposedAction: req.proposedAction,
      resumeStep: req.resumeStep,
      ...(req.options !== undefined ? { options: req.options } : {}),
    })
    return isString(built?.id) ? built.id : ""
  } catch {
    return ""
  }
}

/** Build the frozen resolution object — caller cannot mutate the result
 *  reference to perturb internal state. */
const buildResolution = (
  approvalId: string,
  decision: ApprovalDecision,
  modifiedAction: string | undefined,
): ApprovalGateResolution => {
  const base: ApprovalGateResolution = {
    approvalId,
    decision,
    ...(modifiedAction !== undefined ? { modifiedAction } : {}),
  }
  return Object.freeze(base)
}

export const createApprovalGate = (deps: ApprovalGateDeps): ApprovalGatePort => {
  const open: ApprovalGatePort["open"] = async (
    req: ApprovalGateRequest,
    resolver: ApprovalGateResolver,
  ): Promise<ApprovalGateResolution> => {
    // Invoke the resolver before minting local attribution. A deferred runtime
    // resolver throws its kernel approval id; minting after that preserves one
    // canonical record instead of creating then falsely denying a local id.
    let raw: ApprovalGateResolverReturn
    try {
      raw = await resolver(req)
    } catch (err) {
      const kernelApprovalId = kernelApprovalIdOf(err)
      if (kernelApprovalId !== undefined) {
        safeRequest(deps, req, kernelApprovalId)
        throw err
      }
      const approvalId = safeRequest(deps, req)
      safeSettle(deps, approvalId, "deny")
      throw err
    }

    const approvalId = safeRequest(deps, req)
    // Normalize + settle. SM coerces unknown decisions to "deny" itself;
    //    the gate's RETURN preserves the raw decision so callers see what the
    //    resolver actually said. Reasoning: the gate's job is attribution, not
    //    decision policing.
    const { decision, modifiedAction } = normalizeResolverReturn(raw)
    safeSettle(deps, approvalId, decision, modifiedAction)

    // Surface the resolver's stated decision verbatim. For unknown enum
    //    values the caller still sees the malformed value as-typed; the SM
    //    record's coerced value is observable via `sm.get(approvalId)`.
    return buildResolution(approvalId, decision, modifiedAction)
  }

  const cancel: ApprovalGatePort["cancel"] = (approvalId: string): void => {
    if (deps.approvalSM === undefined) return
    if (!isString(approvalId) || approvalId.length === 0) return
    try {
      deps.approvalSM.cancel(approvalId)
    } catch {
      // SM failure must not propagate past the gate boundary.
    }
  }

  return { open, cancel }
}
