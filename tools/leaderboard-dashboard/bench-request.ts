/**
 * Pure request-shaping helpers for the benchmark MANAGEMENT console (RFC jun-29).
 *
 * The server.ts routes are a THIN adapter: they hand the raw JSON body here to be
 * coerced into the typed {@link LaunchSpec} / iid that {@link ./bench-control} +
 * {@link ./bench-actions} consume, and derive the live preset allowlist from the
 * knob catalog. NO process spawning, NO validation of *values* (that's bench-actions,
 * the single privilege boundary) — this only does shape coercion + catalog projection
 * so it stays unit-testable apart from server.ts (which calls Bun.serve at import).
 */
import type { Family, LaunchSpec } from "./bench-actions"

/** Fallback preset allowlist when the knob catalog is unavailable (matches the
 *  ctor contract in the build prompt). bench-actions still re-checks the shape. */
export const FALLBACK_PRESETS: ReadonlySet<string> = new Set([
  "agentless-v1",
  "agentless-v3-thin-strict",
  "baseline",
])

/** Project the knob-catalog `presets` object into the live preset allowlist. Empty
 *  / malformed catalogs fall back to {@link FALLBACK_PRESETS} so a launch is still
 *  possible (with the built-in safe set). */
export const presetsFromCatalog = (
  presets: Record<string, unknown> | undefined,
): ReadonlySet<string> => {
  const keys = presets ? Object.keys(presets) : []
  return keys.length > 0 ? new Set(keys) : FALLBACK_PRESETS
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** Coerce an untrusted JSON body into a {@link LaunchSpec}. Only shapes the fields —
 *  bench-actions.buildLaunchAction does the allowlist/pattern validation and throws
 *  ActionError (→ HTTP 400) on anything bad, so we never pre-judge values here. */
export const launchSpecFromBody = (body: unknown): LaunchSpec => {
  const b = (body ?? {}) as Record<string, unknown>
  const spec: LaunchSpec = {
    family: str(b.family) as Family,
    dataset: str(b.dataset),
    preset: str(b.preset),
    model: str(b.model) || "gpt-5.5",
  }
  const instances = str(b.instances)
  if (instances !== "") spec.instances = instances
  if (b.onDemand === true) spec.onDemand = true
  return spec
}

/** Pull the box instance-id out of an untrusted body (string-coerced; bench-actions
 *  validates the `i-…` shape). */
export const iidFromBody = (body: unknown): string => str((body as Record<string, unknown>)?.iid)
