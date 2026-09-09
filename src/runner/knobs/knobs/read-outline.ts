/**
 * Knob: `read-outline` — give the `read` tool an outline-first mode so the
 * agent gets a structural map of a file before paying for the full body.
 *
 * Default-OFF. The actual feature is a runtime-config knob read at wire time
 * via `runtimeConfig()` (envKey `QUANTA_READ_OUTLINE`), so APPLY IS A NOOP —
 * this registry entry exists ONLY so the bench resolver / report / preset layer
 * can SEE the knob. `buildConfig` bridges an active resolved value to the
 * runtime-config live-override store (`setKnobOverride`) so the wire-time read
 * picks it up. Strict truthy gate: canonical `isTruthyToken` (`1`/`on`/`true`/`yes`).
 */

import type { AgentConfig } from "@/agent"
import { isTruthyToken } from "@/shared"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseReadOutline = (raw: string | undefined): true | undefined =>
  isTruthyToken(raw) ? true : undefined

const applyReadOutline = (cfg: AgentConfig): AgentConfig => cfg

export const readOutlineKnob: Knob<true> = {
  id: "read-outline",
  envKey: "QUANTA_READ_OUTLINE",
  category: "tool",
  surfaces: SURFACES,
  parse: parseReadOutline,
  apply: applyReadOutline,
  describe: "Outline-first read mode (structural map before full file body)",
  source: "Agentless absorption / Codex realtime-startup-context",
}

registerKnob(readOutlineKnob)
