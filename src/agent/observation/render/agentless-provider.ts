/**
 * Agentless-as-provider adapter (jul-6 S3). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§4, provider catalog).
 *
 * Wraps an ALREADY-PRODUCED `AgentlessLocalizeResult` as an `ObservationProvider`
 * so the existing LLM localizer plugs into the observation pipeline WITHOUT
 * re-running it. This adapter does NOT call the LLM / localizer — it is a pure
 * shape transform over the result the caller passes in.
 *
 * Mapping (byte-identity precondition — kept in lock-step with
 * `composeAgentlessHint`): `files[i]` ⇒ `owner.file`, `rationales[i] ?? ""` ⇒
 * `owner.evidence` (empty rationale preserved so the legacy renderer's
 * "path only" branch fires identically), `source = "agentless-localize"`.
 */

import type { AgentlessLocalizeResult } from "@/agent/issue-hint/agentless-localize"
import type { ObservationFragment, OwnerHint } from "../fragment"
import type { ObservationProvider, TaskContext } from "../port"

export const AGENTLESS_PROVIDER_ID = "agentless-localize"

/** Build owner hints from an agentless result, preserving order and the
 *  empty-rationale distinction. */
const toOwners = (r: AgentlessLocalizeResult): OwnerHint[] => {
  const owners: OwnerHint[] = []
  for (let i = 0; i < r.files.length; i++) {
    const file = r.files[i]
    if (file === undefined) continue
    owners.push({
      file,
      evidence: r.rationales[i] ?? "",
      source: AGENTLESS_PROVIDER_ID,
    })
  }
  return owners
}

/**
 * Adapt a produced `AgentlessLocalizeResult` into an `ObservationProvider`.
 * `produce` is synchronous over the captured result (no I/O). Empty files ⇒
 * `null` (no signal), matching the `composeAgentlessHint` empty sentinel.
 */
export const agentlessProvider = (result: AgentlessLocalizeResult): ObservationProvider => ({
  id: AGENTLESS_PROVIDER_ID,
  kind: "localization",
  applicable: (ctx: TaskContext) => ctx.capability !== "vision",
  produce: async (): Promise<ObservationFragment | null> => {
    const owners = toOwners(result)
    if (owners.length === 0) return null
    return { providerId: AGENTLESS_PROVIDER_ID, owners }
  },
})
