/**
 * Knob: `dynamic-message-matcher` (H1, jun-24 scaffold SOTA absorption,
 * astropy-13033 dynamic-message residual class).
 *
 * The T2b public declared-expected matcher ABSTAINS whenever the only competing
 * literal a candidate introduces is a DYNAMIC format template (f-string `{…}`,
 * `%s`/`%d`/… printf, or `str.format` field) — the assembled runtime string is not
 * comparable execution-free, so a blanket abstain avoids false-vetoing a correct
 * dynamic fix. The cost is that a candidate which invents a WRONG dynamic message
 * (its hard-coded skeleton contradicts the public spec) is never caught (the 13033
 * residual).
 *
 * When this knob is on, the matcher instead compares the template's FIXED skeleton
 * (the literal fragments around the placeholders) against the declared value V:
 *   - skeleton CONSISTENT with V (the template is just V with the variable bits
 *     abstracted) ⇒ still abstain (a correct dynamic fix must never be vetoed);
 *   - skeleton COMPETING (substantive fixed text that does not align with V's
 *     structure) and none consistent ⇒ the existing clean-mode
 *     `hard:declaredExpectedMatch=false` veto may fire;
 *   - only pure-placeholder / non-substantive templates ⇒ abstain (undecidable).
 *
 * Source is PUBLIC only: the declared value V comes from
 * `extractIssueDeclaredExpected` (public problem-statement text, answer-key guarded
 * in `buildPublicDeclaredExpectedPort`); the candidate skeleton comes from the
 * candidate's OWN patch text. No gold / test_patch / PR-diff input.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`dynamicMessageMatcher`
 * field) — the driver passes `{ dynamicSkeleton: true }` into the declared-expected
 * port ONLY when this knob is on. Presets are NOT touched; the experiment opens via
 * env override only. This is a strict superset of T2b: it only ever NARROWS the
 * abstain region into the existing veto — it cannot manufacture a new gate. Promotion
 * still requires the frozen-slice A/B; a losing knob is deleted, not left as a
 * permanent research flag. Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseDynamicMessageMatcher = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyDynamicMessageMatcher = (cfg: AgentConfig): AgentConfig => cfg

export const dynamicMessageMatcherKnob: Knob<true> = {
  id: "dynamic-message-matcher",
  envKey: "QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER",
  category: "tool",
  surfaces: SURFACES,
  parse: parseDynamicMessageMatcher,
  apply: applyDynamicMessageMatcher,
  describe:
    "H1 dynamic-message-matcher: narrow the spec-fidelity matcher's dynamic-format abstain region by comparing the candidate template's FIXED skeleton against the public declared value (consistent ⇒ abstain, competing ⇒ may veto). Layers on spec-fidelity-invariant; default-OFF ⇒ every template literal abstains as before",
  source: "jun-24 scaffold SOTA absorption plan (H1)",
}

registerKnob(dynamicMessageMatcherKnob)
