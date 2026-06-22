/**
 * Adaptive-escalation router CONTRACT (jun-22 v5 Wave-1 skeleton, group A).
 *
 * The v5 controller asks the LLM ONE question per phase: "given this evidence
 * packet, which deeper phase (if any) is needed?" The model never emits raw knob
 * values or preset names — it returns ONE typed {@link AdaptiveDecision} from a
 * closed schema. This module owns that schema + a fail-closed parser; the
 * action→posture mapping lives in `../posture` (PHASE_MODULES), and the bounded
 * transition rules live in `./transitions`.
 *
 * Authority fence (v5 readme): the route decision is PHASE-ROUTING ONLY. Submit
 * authority stays with the executed-proof / clean-selector rails. Any invalid or
 * unparseable model output FAILS CLOSED — the caller must treat `{ok:false}` as
 * "do not submit; escalate as needs-human / typed stop", never as a silent pass.
 *
 * Nothing here is wired into a live run yet — the Wave-3 controller is the sole
 * intended consumer (the LLM call + driver wiring are deferred). Correctness is
 * pinned by the schema hellgate (closed enums, cited-evidence-only, fail-closed)
 * and the action-drift ratchet against PHASE_MODULES.
 */

import { type AdaptiveAction, PHASE_MODULES } from "../posture"

export type { AdaptiveAction }

/**
 * Why the thin attempt looks insufficient. A closed taxonomy so RCA never has to
 * parse free-text (mirrors the v5 readme). The model may cite zero or more.
 */
export type EvidenceGap =
  | "localization_uncertain"
  | "issue_condition_not_evidenced"
  | "candidate_no_positive_proof"
  | "multi_owner_likely"
  | "base_repro_missing"
  | "regression_signal_missing"
  | "infra_blocked"

/** The single typed object the model returns. No knob values, no preset names. */
export interface AdaptiveDecision {
  readonly action: AdaptiveAction
  readonly evidenceGaps: readonly EvidenceGap[]
  /** Evidence ids the model relied on — MUST be a subset of the packet's ids. */
  readonly citedEvidenceIds: readonly string[]
  readonly why: string
}

/** Closed action set — derived from the SAME source the posture map handles, so
 *  the router can never emit an action PHASE_MODULES doesn't know (drift ratchet
 *  pins this). */
export const ADAPTIVE_ACTIONS: ReadonlySet<AdaptiveAction> = new Set(
  Object.keys(PHASE_MODULES) as AdaptiveAction[],
)

export const EVIDENCE_GAPS: ReadonlySet<EvidenceGap> = new Set<EvidenceGap>([
  "localization_uncertain",
  "issue_condition_not_evidenced",
  "candidate_no_positive_proof",
  "multi_owner_likely",
  "base_repro_missing",
  "regression_signal_missing",
  "infra_blocked",
])

/** JSON Schema for the StructuredOutput tool the model is forced to call. Closed
 *  enums make a malformed action/ gap impossible at the tool-call layer; the
 *  parser below is the defense-in-depth that also enforces cited-evidence scope
 *  (which a static schema cannot express — it depends on the live packet). */
export const ADAPTIVE_DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "evidenceGaps", "citedEvidenceIds", "why"],
  properties: {
    action: { type: "string", enum: [...ADAPTIVE_ACTIONS] },
    evidenceGaps: { type: "array", items: { type: "string", enum: [...EVIDENCE_GAPS] } },
    citedEvidenceIds: { type: "array", items: { type: "string" } },
    why: { type: "string" },
  },
} as const

export type AdaptiveParse =
  | { readonly ok: true; readonly decision: AdaptiveDecision }
  | { readonly ok: false; readonly reason: string }

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string")

/**
 * Parse + validate raw model output into an {@link AdaptiveDecision}, FAIL-CLOSED.
 * Rejects (returns `{ok:false}`) on: non-object, missing/typed-wrong fields, an
 * action outside the closed set, any evidenceGap outside the closed set, or a
 * cited evidence id NOT present in `citableIds` (the current packet's ids). The
 * caller maps any `{ok:false}` to a non-submit / escalate-needs-human stop.
 */
export const parseAdaptiveDecision = (
  raw: unknown,
  citableIds: ReadonlySet<string>,
): AdaptiveParse => {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not_an_object" }
  const o = raw as Record<string, unknown>
  if (typeof o.action !== "string" || !ADAPTIVE_ACTIONS.has(o.action as AdaptiveAction))
    return { ok: false, reason: `unknown_action:${String(o.action)}` }
  if (!Array.isArray(o.evidenceGaps) || !o.evidenceGaps.every((g) => typeof g === "string"))
    return { ok: false, reason: "evidenceGaps_not_string_array" }
  const badGap = (o.evidenceGaps as string[]).find((g) => !EVIDENCE_GAPS.has(g as EvidenceGap))
  if (badGap !== undefined) return { ok: false, reason: `unknown_evidence_gap:${badGap}` }
  if (!isStringArray(o.citedEvidenceIds))
    return { ok: false, reason: "citedEvidenceIds_not_string_array" }
  const uncited = o.citedEvidenceIds.find((id) => !citableIds.has(id))
  if (uncited !== undefined) return { ok: false, reason: `uncited_evidence_id:${uncited}` }
  if (typeof o.why !== "string") return { ok: false, reason: "why_not_string" }
  return {
    ok: true,
    decision: {
      action: o.action as AdaptiveAction,
      evidenceGaps: o.evidenceGaps as EvidenceGap[],
      citedEvidenceIds: o.citedEvidenceIds,
      why: o.why,
    },
  }
}
