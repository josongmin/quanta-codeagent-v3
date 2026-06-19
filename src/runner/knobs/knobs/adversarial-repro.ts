/**
 * Knob: `adversarial-repro` — repro-quality lever (jun-19, #10999 under-fix class).
 *
 * The Agentless §3.3.1 reproduction script is surfaced to the agent as a
 * post-fix self-check ("run `python reproduce_issue.py` — it must print 'Issue
 * resolved'"). By default the script tests the issue's OWN happy-path example,
 * so a SHALLOW fix that only handles that example prints "Issue resolved" and
 * the agent stops — a false-GREEN. Measured on django-10999: ownerHit +
 * repro-base-RED yet UNRESOLVED, because the agent copied the issue's
 * incomplete suggested regex and the weak repro passed it.
 *
 * ON ⇒ the repro-generation prompt gets an ADVERSARIAL-coverage block (boundary
 * / must-reject / consistency cases derived by reasoning about a correct fix,
 * and an explicit "do NOT copy the issue's proposed fix") so a superficial
 * patch stays RED and the agent keeps fixing. Default-OFF ⇒ byte-identical
 * repro prompt.
 *
 * APPLY IS A NOOP — the EFFECT is delivered out of band by the bench driver:
 * `benchPostureFromState` projects `adversarialRepro`, which `installReproTestHint`
 * threads into `generateReproTests({ adversarial })`. Registry status is required
 * for resolver/report/preset. Strict truthy gate: unset/`0`/`off`/`false` ⇒ off.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseAdversarialRepro = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}

const applyAdversarialRepro = (cfg: AgentConfig): AgentConfig => cfg

export const adversarialReproKnob: Knob<boolean> = {
  id: "adversarial-repro",
  envKey: "QUANTA_BENCH_ADVERSARIAL_REPRO",
  category: "tool",
  surfaces: SURFACES,
  parse: parseAdversarialRepro,
  apply: applyAdversarialRepro,
  describe:
    "Adversarial repro coverage (boundary/must-reject/no-copy-suggested-fix) so a shallow fix stays RED (#10999 under-fix class)",
  source: "jun-19 repro-quality domino (10999 RCA: weak repro false-GREEN on under-fix)",
}

registerKnob(adversarialReproKnob)
