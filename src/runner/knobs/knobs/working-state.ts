/**
 * Knob: `working-state` — Codex memory L3 (scratchpad) wiring.
 *
 * When set, the loop builds a session-scoped `WorkingState`, plumbs it through
 * `ToolContext.workingState`, registers the `update_working_state` meta-tool,
 * and renders the L3 block in the per-turn reminder. The actual slice lives at
 * `src/agent/working-state.ts` + `src/agent/types/agent-capabilities.ts`
 * (`WorkingStateBlock = { enabled: boolean }`).
 *
 * Surface set EXCLUDES `bench`: measurement integrity — L3 alters the per-turn
 * reminder shape, so SWE-bench-style runs stay byte-identical. CLI / agent-*
 * surfaces opt in via `QUANTA_BENCH_WORKING_STATE=1`.
 *
 * STRICT truthy gate — only `"1"`, `"on"`, `"true"` parse to `true`. Falsy /
 * garbage / empty / whitespace return `undefined` so the caller falls through
 * to the next layer (NOT a silent "off"). No heuristics.
 */

import type { AgentConfig } from "@/agent"
import { workingStateSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/knobs/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/** Non-NOOP apply — wires `cfg.workingState`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applyWorkingState = (
  cfg: AgentConfig,
  value: true,
  ctx: { surface: Surface },
): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  // Idempotent: preserve any caller-supplied workingState block (the
  // framework's layered-resolve may have already folded a config-file value;
  // we only flip `enabled`, never overwrite).
  return { ...cfg, workingState: { ...(cfg.workingState ?? {}), enabled: true } }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const workingStateKnob = deriveKnob(workingStateSchema, applyWorkingState)
