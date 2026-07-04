import type { LLMPort } from "@/llm"
import type { Role } from "@/llm/role-model-override"
import { QuantaError } from "@/shared"
import type { SubagentRequest } from "../subagent/types"
import { type EffortLevel, parseEffort } from "./effort"
import type { AgentConfig } from "./types"

/**
 * ADR-0451 — raised when a child subagent requested a model id (explicitly via
 * `req.model`, or indirectly because its `req.role` resolved to a non-parent
 * model) that has NO matching entry in the parent's `modelCandidates`. This is
 * the FAIL-CLOSED guard: rather than silently running the child on the wrong
 * model (the parent's), the spawn aborts so the parent learns its delegation
 * intent could not be honored. A {@link QuantaError} subclass so the host's
 * typed-error union holds.
 */
export class UnknownSubagentModelError extends QuantaError {
  constructor(modelId: string, source: "model" | "role") {
    super(
      "unknown_subagent_model",
      source === "model"
        ? `requested subagent model "${modelId}" is not an enabled candidate (modelCandidates); ` +
            `cannot honor the model override (fail-closed, no silent fallback)`
        : `role resolved to model "${modelId}" which is not an enabled candidate (modelCandidates); ` +
            `cannot honor the role override (fail-closed, no silent fallback)`,
    )
  }
}

/** Swap to the `modelCandidates` entry whose id matches `modelId`, or fail
 *  closed via {@link UnknownSubagentModelError}. This is the SAME lookup shape
 *  as `loop.ts`'s skill-model-swap (`modelCandidates.find(c => c.id === id)`),
 *  but raises instead of degrading silently. */
const swapToCandidate = (
  parent: AgentConfig,
  modelId: string,
  source: "model" | "role",
): LLMPort => {
  const match = parent.modelCandidates?.find((c) => c.id === modelId)
  if (match === undefined) throw new UnknownSubagentModelError(modelId, source)
  return match.port
}

/**
 * ADR-0451 — resolve the child's effective LLM port from the model/role
 * override on the request. Precedence (highest first):
 *
 *   1. explicit `req.model`  — swap to the candidate with that id
 *   2. `req.role`            — `roleModelResolver.resolve(role, parentModel)`,
 *                              then swap to the candidate with the resolved id
 *                              (a role that falls through to the parent model ⇒
 *                              no swap)
 *   3. neither               — `parent.llm` verbatim (byte-identical default)
 */
export const resolveChildLlm = (parent: AgentConfig, req: SubagentRequest): LLMPort => {
  const parentModel = parent.llm.model
  if (req.model !== undefined && req.model.length > 0) {
    return swapToCandidate(parent, req.model, "model")
  }
  if (req.role !== undefined && req.role.length > 0 && parent.roleModelResolver !== undefined) {
    const resolved = parent.roleModelResolver.resolve(req.role as Role, parentModel ?? "")
    if (resolved.length === 0 || resolved === parentModel) return parent.llm
    return swapToCandidate(parent, resolved, "role")
  }
  return parent.llm
}

/** ADR-0451 — derive the child's `sessionEffort` thunk from `req.effort`.
 *  Returns `undefined` when no recognised named tier is present. */
export const resolveChildEffort = (
  req: SubagentRequest,
): (() => EffortLevel | undefined) | undefined => {
  if (req.effort === undefined) return undefined
  const level = parseEffort(req.effort)
  if (level === undefined) return undefined
  return () => level
}
