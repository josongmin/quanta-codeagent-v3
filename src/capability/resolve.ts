/**
 * `@/capability/resolve.ts` — the SINGLE cross-surface exposure resolver
 * (ADR-0503 P3 / RFC §4) + the master-gate consistency PROBE.
 *
 * `resolveExposure(cap, surface, env)` is the ONE place a capability's exposure
 * on a surface is decided: exposed IFF the capability declares the surface
 * (surfaces[surface] === true) AND the env gate is on. PURE — env is injected
 * (DI), never read from `process.env` — so it is safe in any layer and fully
 * testable.
 *
 * MASTER GATE. The whole capability layer is behind `QUANTA_CAPABILITY_LAYER`
 * (default-OFF, strict opt-in). While OFF, the resolver is NOT wired into any
 * live surface gate — each surface keeps its existing per-surface env read
 * (byte-identical degrade). The only ON-gated wiring is {@link
 * probeExposureConsistency}: a read-only drift detector that cross-checks the
 * resolver against the legacy per-surface gate and NEVER mutates behavior.
 */

import { gateOn, gateOnStrict, readBool } from "@/shared"
import type { CapabilityDescriptor, Surface } from "./descriptor"

/** The master env gate for the whole capability layer. */
export const CAPABILITY_LAYER_ENV = "QUANTA_CAPABILITY_LAYER"

/**
 * Is `cap` exposed on `surface`? True IFF the capability declares the surface
 * (surfaces[surface] === true) AND its own env gate is on AND EVERY composite
 * `requires` gate is truthy. Pure (env injected).
 *
 * COMPOSITE GATE. The REAL llmTool exposure is composite — e.g. workflow's
 * `run_workflow` is `enabled && (QUANTA_WORKFLOW ?? false)` where `enabled` is
 * the default-ON parent QUANTA_SUBAGENT gate. So `resolveExposure` ANDs the own
 * gate with each `cap.requires` entry. Each require is read with the SAME default
 * the real assembly uses (`readBool(env[envKey], r.defaultOn)`), so for a
 * default-ON parent an UNSET gate predicts ON (matching the source) — a plain
 * `gateOn` would mispredict it as OFF. The own gate stays `gateOn` (default-OFF
 * opt-in, byte-identical to `readBool(.., false)`).
 *
 * For `runtimeConditioned` caps this remains the env-only prediction: a
 * NECESSARY-not-sufficient UPPER BOUND (real ⊆ predicted), since a non-env
 * runtime signal (e.g. a provider key) can only narrow it further.
 */
export const resolveExposure = (
  cap: CapabilityDescriptor,
  surface: Surface,
  env: Record<string, string | undefined>,
): boolean => {
  // BOTH conditions required — dropping the surface check is the split-brain bug
  // the e2e hellgate fences (red-on-injection).
  if (cap.surfaces[surface] !== true) return false
  if (!gateOn(env, cap.gate.envKey)) return false
  // COMPOSITE: every additional gate must ALSO pass, read with the real
  // assembly's default (default-ON parents predict ON when unset). Dropping this
  // is the workflow split-brain (QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0) the
  // reality hellgate fences (red-on-injection).
  return (cap.requires ?? []).every((r) => readBool(env[r.envKey], r.defaultOn))
}

/** Result of the consistency probe (only produced when the master gate is on). */
export interface ExposureProbe {
  /** What the unified resolver decided for this surface. */
  readonly resolved: boolean
  /** What the legacy per-surface env gate read decides (gateOn on the gate key). */
  readonly legacy: boolean
  /** Do they agree? `false` ⇒ split-brain drift detected (report-only). */
  readonly agrees: boolean
}

/**
 * READ-ONLY consistency probe (the only wiring active under the master gate).
 *
 * When `QUANTA_CAPABILITY_LAYER` is OFF ⇒ returns `undefined` (byte-identical
 * no-op: the layer asserts nothing, legacy gates stay authoritative). When ON ⇒
 * cross-checks {@link resolveExposure} against the legacy per-surface gate read
 * and reports agreement. It NEVER changes behavior — it exists to surface drift
 * (tool on / slash off) so split-brain is caught, not silently shipped.
 *
 * `gateOnStrict` for the master gate: arming a cross-cutting layer is a
 * deliberate `=1`, never a stray truthy value.
 */
export const probeExposureConsistency = (
  cap: CapabilityDescriptor,
  surface: Surface,
  env: Record<string, string | undefined>,
): ExposureProbe | undefined => {
  if (!gateOnStrict(env, CAPABILITY_LAYER_ENV)) return undefined
  const resolved = resolveExposure(cap, surface, env)
  const legacy = gateOn(env, cap.gate.envKey)
  return { resolved, legacy, agrees: resolved === legacy }
}
