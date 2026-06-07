/**
 * Knob: `localize-phase` — Agentless "localize-first" guard (Tier-0
 * absorption, Agentless paper §3.1).
 *
 * Default-OFF. Migrated verbatim from `parseLocalizePhaseEnv` in
 * `src/runner/batch/eval/driver.ts`. Apply sets
 * `cfg.localizePhase = { phase1Turns: N }`.
 *
 * Domain (ACTIVE):
 *   - integer N in [1, 20] ⇒ `{ phase1Turns: N }`.
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / empty string
 *   - non-numeric (`"garbage"`, `"1.5"`, `"abc"`)
 *   - 0 / negative / NaN / Infinity
 *   - > 20 (measurement-integrity cap — phase1Turns > 20 on a maxTurns=30 run
 *     would starve repair)
 *
 * Closed parser: explicit `Number.isFinite` + `Number.isInteger` checks (no
 * `parseInt`-then-coerce that would silently swallow "1abc" as 1). No
 * heuristics.
 *
 * Conflicts with `branch-search` — both strengthen explore; running them
 * together confounds A/B measurement.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

interface LocalizePhaseValue {
  readonly phase1Turns: number
}

const parseLocalizePhase = (raw: string | undefined): LocalizePhaseValue | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  // Number(...) (NOT parseInt) so "1abc"/"1.5" cleanly become NaN /
  // non-integer and fail the validity check — no partial-parse foot-gun.
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 1) return undefined
  if (n > 20) return undefined
  return { phase1Turns: n }
}

const applyLocalizePhase = (
  cfg: AgentConfig,
  value: LocalizePhaseValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, localizePhase: { phase1Turns: value.phase1Turns } }
}

export const localizePhaseKnob: Knob<LocalizePhaseValue> = {
  id: "localize-phase",
  envKey: "QUANTA_BENCH_LOCALIZE_PHASE",
  category: "agent",
  surfaces: SURFACES,
  parse: parseLocalizePhase,
  apply: applyLocalizePhase,
  describe: "Block mutating tools during first N turns; force localize-first (Agentless §3.1)",
  conflicts: ["branch-search"],
  source: "Agentless absorption",
}

registerKnob(localizePhaseKnob)
