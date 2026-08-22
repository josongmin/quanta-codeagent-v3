/**
 * RFC-05 E5 — the AGENT-owned `request_user_input` availability GUARD.
 *
 * This is the bridge the RFC-05 architecture calls for: "The agent bridge
 * consumes a narrow `QuestionAvailabilityReader` and applies the same predicate
 * both when building live tool specs and at dispatch." The permission slice owns
 * the PREDICATE (`@/permission/posture/question-policy` `canRequestUserInput`);
 * THIS file owns the agent-side binding of the LIVE turn facts into it, and the
 * ONE shared entry point (`questionAvailability`) both consumers call so
 * visibility and execution can never diverge.
 *
 * Why agent-owned / duck-typed (RFC-05 hard rule + board §5 lock "`tool/{types,
 * registry}.ts` is F3-only; E5 consumes an agent guard instead"): the `@/tool`
 * slice MUST NOT import `@/permission`. So the capability the composition binds
 * onto `AgentConfig.questionGuard` is the narrow, agent-defined
 * {@link QuestionAvailabilityReader} — a duck-typed reader of the live bound
 * `askOutsidePlan`. The tool substrate is untouched; enforcement lives entirely
 * in the agent slice (the spec projection + the dispatch consult).
 *
 * REAL turn mode, not a snapshot: {@link questionAvailability} reads the reader
 * FRESH on every call and takes the turn's live collaboration mode, so a posture
 * change between the (once-per-session) spec build and a later dispatch is
 * honored — closing the "cached tool inventories can hide a tool while direct
 * dispatch remains open" trap. {@link livePostureQuestionReader} adapts the E3
 * live `PostureAuthority` so `askOutsidePlan()` re-reads `read().effective`
 * each call.
 */

import type { PostureAuthority } from "@/permission/posture/authority"
import {
  canRequestUserInput,
  QUESTION_AVAILABLE,
  type QuestionAvailability,
  type QuestionTurnMode,
} from "@/permission/posture/question-policy"
import type { CollaborationMode } from "../mode"

/** The narrow, duck-typed capability bound onto `AgentConfig.questionGuard`. It
 *  is a LIVE reader of the bound question knob — `askOutsidePlan()` is re-read on
 *  every availability check so the answer tracks the current posture, never a
 *  build-time snapshot. Agent-owned so the `@/tool` slice never imports
 *  `@/permission`. */
export interface QuestionAvailabilityReader {
  /** The live bound `askOutsidePlan` (RFC-05 E1). `true` ⇒ the agent may ask
   *  outside plan mode. */
  askOutsidePlan(): boolean
}

/** Map the agent's collaboration mode onto the policy's {@link QuestionTurnMode}.
 *  `"plan"` ⇒ plan; any other KNOWN mode ⇒ outside plan; `undefined` (the mode
 *  was not resolvable at this bridge) ⇒ `undefined` = the UNKNOWN context the
 *  predicate resolves RESTRICTIVELY. */
export const turnModeFromCollab = (
  collab: CollaborationMode | undefined,
): QuestionTurnMode | undefined =>
  collab === "plan" ? "plan" : collab === "default" ? "outside_plan" : undefined

/**
 * THE single availability entry point both consumers (spec projection +
 * dispatch consult) call — so ONE reader result controls BOTH sites.
 *
 * DEFAULT-OFF: when no reader is bound (`reader === undefined`) the answer is
 * unconditionally AVAILABLE, i.e. the current-behavior default (question
 * available by default when no posture denies) — byte-identical to the
 * pre-E5 path.
 *
 * When a reader IS bound, the live `askOutsidePlan()` + the turn's collaboration
 * mode flow through the permission-slice predicate `canRequestUserInput`.
 */
export const questionAvailability = (
  reader: QuestionAvailabilityReader | undefined,
  collab: CollaborationMode | undefined,
): QuestionAvailability => {
  if (reader === undefined) return QUESTION_AVAILABLE
  return canRequestUserInput({
    askOutsidePlan: reader.askOutsidePlan(),
    turnMode: turnModeFromCollab(collab),
  })
}

/**
 * Adapt the E3 live {@link PostureAuthority} into a {@link QuestionAvailabilityReader}.
 * `askOutsidePlan()` re-reads `authority.read().effective.askOutsidePlan` on
 * every call, so the reader reflects the CURRENT bound posture (proving "real
 * turn mode bound, not a snapshot"). This is the seam a composition root wires
 * `AgentConfig.questionGuard` from; it lives in agent space (deep type-only
 * import of the permission authority is permitted for the agent slice) so the
 * tool substrate stays permission-free.
 */
export const livePostureQuestionReader = (
  authority: PostureAuthority,
): QuestionAvailabilityReader => ({
  askOutsidePlan: () => authority.read().effective.askOutsidePlan,
})
