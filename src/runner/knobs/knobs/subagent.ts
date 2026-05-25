/**
 * Knob: `subagent` — wire the Tier-1 subagent system (ADR-0011).
 *
 * Default-OFF posture (RFC §1.2). Migrated verbatim from the
 * `QUANTA_BENCH_SUBAGENT=1` resolve path in `src/runner/batch/eval/driver.ts`
 * `benchOptIns()`. Apply sets `cfg.subagent = {}` — bench never tunes
 * `maxDepth` / `taskRegistry` (measurement integrity).
 *
 * Strict truthy gate: only `"1"` / `"on"` / `"true"` parse to `true`; anything
 * else (including `"yes"`, `"True"`, `"0"`, garbage, empty, whitespace) ⇒
 * `undefined`. No heuristics.
 */

import type { AgentConfig } from "@/agent"
import {type Knob, type Surface } from "../types"
import { registerKnob } from "../registry"

const SURFACES: readonly Surface[] = ["bench"]
const TRUTHY = new Set(["1", "on", "true"])

const parseSubagent = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? true : undefined
}

const applySubagent = (cfg: AgentConfig, value: true, ctx: { surface: Surface }): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, subagent: cfg.subagent ?? {} }
}

export const subagentKnob: Knob<true> = {
  id: "subagent",
  envKey: "QUANTA_BENCH_SUBAGENT",
  category: "agent",
  surfaces: SURFACES,
  parse: parseSubagent,
  apply: applySubagent,
  describe: "Wire the Tier-1 subagent system (Agent/Task/TaskOutput/TaskStop tools)",
  source: "Codex absorption Phase 0-8",
}

registerKnob(subagentKnob)
