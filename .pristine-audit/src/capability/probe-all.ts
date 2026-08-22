/**
 * `@/capability/probe-all.ts` — the cross-capability consistency-probe RUNNER
 * (ADR-0503 P3 / RFC §4, the bootstrap-armed drift sweep).
 *
 * `probeExposureConsistency` (resolve.ts) probes ONE (cap, surface) pair against
 * the legacy per-surface gate. This runner is the thin fan-out that the session
 * bootstrap arms: when the master gate `QUANTA_CAPABILITY_LAYER` is ON, it runs
 * the probe across EVERY declared capability × EVERY surface that capability
 * declares, and returns the per-pair {@link ExposureProbe} results so the caller
 * can SURFACE any split-brain (`agrees === false`) via a log / observability
 * event. READ-ONLY — it asserts nothing and mutates no behavior.
 *
 * MASTER GATE / byte-identical. When the gate is OFF this returns `[]` WITHOUT
 * touching the registry, the resolver, or the injected lookup — the #1
 * invariant: an un-armed bootstrap path adds ZERO behavior. The master-gate read
 * is `gateOnStrict` (arming a cross-cutting layer is a deliberate `=1`).
 *
 * PURE / DI. The legacy per-surface gate is INJECTED (`legacyGateFor`) — the
 * runner never reads `process.env` and never decides what "legacy" means for a
 * surface, so it stays testable and the caller owns the surface-specific gate
 * semantics (for `llmTool` caps the legacy gate is `gateOn(env, cap.gate.envKey)`).
 *
 * `resolveExposure` is now the COMPOSITE prediction (own gate AND every
 * `requires` gate), so for a composite cap the resolved side can DISAGREE with
 * the lone own-gate legacy read — that disagreement is the REAL split-brain the
 * sweep exists to surface (e.g. QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0).
 */

import { gateOnStrict } from "@/shared"
import type { CapabilityDescriptor, Surface } from "./descriptor"
import { allCapabilities } from "./registry"
import { CAPABILITY_LAYER_ENV, type ExposureProbe, resolveExposure } from "./resolve"

/** Every surface key a capability declaration can carry (drives the sweep). */
const ALL_SURFACES: readonly Surface[] = ["llmTool", "slash", "skill", "hook", "thinClient"]

/** A single probe result tagged with the (capability, surface) it covers, so a
 *  split-brain finding is attributable in a log / observability event. */
export interface CapabilityProbeResult extends ExposureProbe {
  /** The capability id this pair covers. */
  readonly capabilityId: string
  /** The surface this pair covers. */
  readonly surface: Surface
}

/**
 * Run the consistency probe across every declared capability × the surfaces it
 * declares.
 *
 * - `QUANTA_CAPABILITY_LAYER` OFF ⇒ returns `[]` (byte-identical no-op — nothing
 *   is iterated, the injected lookup is never called).
 * - ON ⇒ for each capability and each surface it declares (`surfaces[s] === true`)
 *   it cross-checks {@link resolveExposure} against the INJECTED legacy gate and
 *   returns a {@link CapabilityProbeResult} per pair. `agrees === false` marks a
 *   split-brain the caller should surface. It never mutates behavior.
 *
 * @param env          injected env (DI — never read from `process.env` here).
 * @param legacyGateFor injected legacy per-surface gate lookup to compare against
 *                      (for `llmTool` caps: `gateOn(env, cap.gate.envKey)`).
 */
export const runCapabilityProbe = (
  env: Record<string, string | undefined>,
  legacyGateFor: (cap: CapabilityDescriptor, surface: Surface) => boolean,
): CapabilityProbeResult[] => {
  // #1 INVARIANT: gate OFF ⇒ zero behavior. Bail BEFORE touching the registry or
  // calling the injected lookup, so an un-armed bootstrap is byte-identical.
  if (!gateOnStrict(env, CAPABILITY_LAYER_ENV)) return []

  const results: CapabilityProbeResult[] = []
  for (const cap of allCapabilities()) {
    for (const surface of ALL_SURFACES) {
      // Only sweep surfaces the capability actually declares — an absent surface
      // is not a split-brain, it is simply out of scope for this capability.
      if (cap.surfaces[surface] !== true) continue
      const resolved = resolveExposure(cap, surface, env)
      const legacy = legacyGateFor(cap, surface)
      results.push({
        capabilityId: cap.id,
        surface,
        resolved,
        legacy,
        agrees: resolved === legacy,
      })
    }
  }
  return results
}
