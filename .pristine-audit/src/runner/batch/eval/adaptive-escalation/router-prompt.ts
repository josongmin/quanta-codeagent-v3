/**
 * Router prompt scaffold (jun-22 v5 Wave-1 skeleton, group A remainder).
 *
 * The STATIC half of the router prompt — the closed action menu, the evidence-gap
 * taxonomy, and the hard authority rules — is packet-shape-independent, so it is
 * built here now. The DYNAMIC half (rendering the actual evidence packet into the
 * prompt) is deferred to Wave 3 with the packet SSOT; `buildRouterPrompt` takes a
 * pre-rendered packet string as its only run-time input.
 *
 * The instruction restates the authority fence verbatim so the model cannot
 * mistake routing for submission: ONE action from the closed menu, cite only the
 * packet's evidence ids, never name a preset, never emit a knob value. The
 * parser (`parseAdaptiveDecision`) enforces these structurally; the prompt makes
 * them explicit so the model does not waste a turn proposing illegal output.
 */

import {
  ADAPTIVE_ACTIONS,
  type AdaptiveAction,
  EVIDENCE_GAPS,
  type EvidenceGap,
} from "./decision-schema"

/** One-line meaning of each phase the controller can route to. `Record<Union,…>`
 *  forces this to stay complete as the action set evolves (compile-time drift). */
export const ACTION_DESCRIPTIONS: Record<AdaptiveAction, string> = {
  accept_thin: "Submit the current thin candidate as-is; no deeper phase is needed.",
  expand_select: "Generate a few more candidates and let clean late-selection pick (cheap).",
  run_public_repro: "Build/extract a public reproduction and run it to create a base oracle.",
  run_proof_clean: "Enter the bounded executable-proof phase; submit only on positive proof.",
  repair_with_proof: "Run one bounded repair round seeded by the proof-failure context.",
  deeper_localize: "Widen owner/witness/family evidence before another generation pass.",
  stop_infra_or_budget:
    "No legal next phase remains (infra blocked / budget out / prerequisite missing); stop.",
}

/** One-line meaning of each evidence gap the model may cite. */
export const EVIDENCE_GAP_DESCRIPTIONS: Record<EvidenceGap, string> = {
  localization_uncertain: "Unsure the candidate touches the right owner/site.",
  issue_condition_not_evidenced: "The issue's declared condition is not yet evidenced.",
  candidate_no_positive_proof: "The candidate has no executed positive proof.",
  multi_owner_likely: "The fix likely spans multiple owners/sites.",
  base_repro_missing: "No base reproduction has been established.",
  regression_signal_missing: "No regression keep-green signal is available.",
  infra_blocked: "Environment/build/tooling prevents progress.",
}

/** Hard rules restated in-prompt (also enforced by the fail-closed parser). */
export const ROUTER_RULES: readonly string[] = [
  "Return EXACTLY ONE action from the closed menu — no other strings.",
  "Cite ONLY evidence ids that appear in the packet below.",
  "NEVER name a preset (e.g. agentless-*) and NEVER emit a knob value — you choose a PHASE, not a config.",
  "You are routing, NOT submitting: submission is decided later by executed proof and the clean selector.",
  "If no deeper phase can help, choose stop_infra_or_budget — do not guess.",
]

const bulletMenu = <K extends string>(ids: Iterable<K>, describe: Record<K, string>): string =>
  [...ids].map((id) => `- ${id}: ${describe[id]}`).join("\n")

/** The static instruction block (closed action menu + gap taxonomy + rules). */
export const buildRouterInstruction = (): string =>
  [
    "You are the phase router for a bounded SWE-bench fix controller.",
    "Given the evidence packet, choose the single best next PHASE.",
    "",
    "ACTIONS (choose exactly one):",
    bulletMenu(ADAPTIVE_ACTIONS, ACTION_DESCRIPTIONS),
    "",
    "EVIDENCE GAPS (cite zero or more that apply):",
    bulletMenu(EVIDENCE_GAPS, EVIDENCE_GAP_DESCRIPTIONS),
    "",
    "RULES:",
    ...ROUTER_RULES.map((r) => `- ${r}`),
  ].join("\n")

/** Full router prompt: static instruction + the rendered evidence packet
 *  (Wave 3 supplies `renderedPacket` from the packet SSOT). */
export const buildRouterPrompt = (renderedPacket: string): string =>
  `${buildRouterInstruction()}\n\nEVIDENCE PACKET:\n${renderedPacket}`
