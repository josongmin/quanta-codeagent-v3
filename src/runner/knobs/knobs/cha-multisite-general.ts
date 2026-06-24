/**
 * Knob: `cha-multisite-general` — generalize the CHA contract-fallback sibling
 * rule from the legacy django/db/backends PATH HARDCODE to a structural
 * parallel-sibling rule (same dir-root + same leaf filename, different variant
 * dir, shared ancestor).
 *
 * The general rule is a STRICT SUPERSET of the django path match (it is
 * byte-identical for django targets and merely additive for other parallel-impl
 * layouts), so this knob removes the instance-family overfit without losing the
 * django-11138/14315 coverage.
 *
 * Default-OFF (byte-identical: `cha-multisite-steer` keeps using the legacy
 * "path-hardcoded" sibling mode). NOOP-apply registry entry: consumed via
 * `benchPostureFromState` + the bench driver's CHA path, not by mutating
 * AgentConfig. Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ general.
 *
 * Has no effect unless `cha-multisite-steer` is also enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])
const DISABLING = new Set(["0", "off", "false"])

const parseChaMultisiteGeneral = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (ENABLING.has(normalized)) return true
  if (DISABLING.has(normalized)) return false
  return undefined
}

const applyChaMultisiteGeneral = (cfg: AgentConfig): AgentConfig => cfg

export const chaMultisiteGeneralKnob: Knob<boolean> = {
  id: "cha-multisite-general",
  envKey: "QUANTA_BENCH_CHA_MULTISITE_GENERAL",
  category: "tool",
  surfaces: SURFACES,
  parse: parseChaMultisiteGeneral,
  apply: applyChaMultisiteGeneral,
  describe:
    "generalize the CHA contract-fallback sibling rule from the django path hardcode to a structural parallel-sibling rule (superset; byte-identical for django)",
  source: "jun-25 cha-multisite path-hardcode generalization",
}

registerKnob(chaMultisiteGeneralKnob)
