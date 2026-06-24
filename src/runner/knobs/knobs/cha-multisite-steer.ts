/**
 * Knob: `cha-multisite-steer` — when the localizer can pin a Python method,
 * run whole-repo CHA to find sibling overrides and append a concrete
 * multi-backend/co-site fix steer naming each sibling file:line.
 *
 * Default-OFF. NOOP-apply registry entry: the value is consumed via
 * `benchPostureFromState` and the bench driver's async hint-precompute path,
 * not by mutating AgentConfig directly. Strict truthy gate:
 * `"1"`/`"on"`/`"true"` ⇒ enabled; `"0"`/`"off"`/`"false"` ⇒ disabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])
const DISABLING = new Set(["0", "off", "false"])

const parseChaMultisiteSteer = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (ENABLING.has(normalized)) return true
  if (DISABLING.has(normalized)) return false
  return undefined
}

const applyChaMultisiteSteer = (cfg: AgentConfig): AgentConfig => cfg

export const chaMultisiteSteerKnob: Knob<boolean> = {
  id: "cha-multisite-steer",
  envKey: "QUANTA_BENCH_CHA_MULTISITE_STEER",
  category: "tool",
  surfaces: SURFACES,
  parse: parseChaMultisiteSteer,
  apply: applyChaMultisiteSteer,
  describe: "append a concrete sibling-override steer from whole-repo CHA when a localized Python method has peer overrides",
  source: "jun-24 django-11138 multisite override miss",
}

registerKnob(chaMultisiteSteerKnob)
