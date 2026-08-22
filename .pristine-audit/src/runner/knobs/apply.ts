/**
 * Fold resolved knob values over a baseline `AgentConfig`.
 *
 * Pure: each knob's `apply` returns a new config; `applyKnobs` chains them.
 * A knob whose surface does not match `ctx.surface` is skipped (defensive —
 * the surface-filtered registry passed in should already exclude these,
 * but the secondary check keeps the apply step robust against caller
 * mistakes).
 *
 * Byte-identical invariant: with EMPTY `values` (no knob resolved), the
 * return value is `===` to `base` (the loop simply does not execute).
 */

import type { AgentConfig } from "@/agent"
import type { AnyKnob, ApplyContext, KnobValueMap } from "./types"

export const applyKnobs = (
  base: AgentConfig,
  knobs: ReadonlyMap<string, AnyKnob>,
  values: KnobValueMap,
  ctx: ApplyContext,
): AgentConfig => {
  let cfg = base
  for (const [id, kv] of values) {
    const knob = knobs.get(id)
    if (!knob) continue
    if (!knob.surfaces.includes(ctx.surface)) continue
    cfg = knob.apply(cfg, kv.value, ctx)
  }
  return cfg
}
