/**
 * Bench-surface knob resolution helper.
 *
 * Thin wrapper around the `@/runner/knobs` framework that:
 *   1. Materialises the bench-surface knob registry view via
 *      `knobsForSurface("bench")`.
 *   2. Resolves each knob's layered value via `resolveKnobs`. ONLY the env-var
 *      layer is fed in — bench DELIBERATELY skips cli / session / config-file
 *      layers (measurement integrity: a stale dev shell or user config file
 *      must NEVER silently change a benchmark result; the operator opts in by
 *      exporting a `QUANTA_BENCH_*` env var explicitly). The preset layer is
 *      enabled (a benchmark sweep wants `--knobs-preset agentless-full` etc.).
 *   3. Returns a `BenchKnobState` carrying the surface registry, the resolved
 *      values, the per-id source map for telemetry, the optional preset name,
 *      and the list of registered-but-inactive knob ids.
 *
 * Byte-identical invariant:
 *   - Empty registry (knob files not yet imported) ⇒ `values` is an empty
 *     `Map`, `inactive` is `[]`, `applyKnobs(baseConfig, ...)` is a no-op
 *     (proved in `apply.ts`).
 *   - Any registered knob whose `parse` rejects its env value falls through to
 *     the next layer (preset, then `default`). A knob with no value in any
 *     layer is reported as `inactive` and NOT applied.
 *
 * The helper is split out from `driver.ts` so unit tests can pin the resolver
 * contract independently of `buildConfig`.
 */

import type { AgentConfig } from "@/agent"
import {
  type ApplyContext,
  applyKnobs,
  type Knob,
  type KnobValueMap,
  knobsForSurface,
  resolveKnobs,
} from "@/runner/knobs"

export interface BenchKnobState {
  /** Bench-surface registry view (frozen by the framework). */
  readonly knobs: ReadonlyMap<string, Knob>
  /** Layered-resolution result, in registry iteration order. */
  readonly values: KnobValueMap
  /** Optional preset name (env: `QUANTA_KNOBS_PRESET`). */
  readonly preset: string | undefined
  /** Registered-but-inactive knob ids (no value resolved + no default). */
  readonly inactive: readonly string[]
}

export interface ResolveBenchKnobsArgs {
  /** Process env snapshot. Required — the helper does NOT read `process.env`
   *  itself (closed-port contract). */
  readonly envVars: NodeJS.ProcessEnv
}

/** Materialise the bench-surface knob registry + resolved values.
 *
 *  The function is referentially transparent over `envVars` once the
 *  registry is fixed: same envVars ⇒ same `BenchKnobState` (proved by the
 *  framework's `resolveKnobs` being a pure function over its inputs). */
export const resolveBenchKnobs = (args: ResolveBenchKnobsArgs): BenchKnobState => {
  const knobs = knobsForSurface("bench")
  const preset = args.envVars.QUANTA_KNOBS_PRESET
  const resolveArgs: Parameters<typeof resolveKnobs>[0] = {
    surface: "bench",
    knobs,
    envVars: args.envVars,
    ...(preset !== undefined && preset !== "" ? { preset } : {}),
  }
  const values = resolveKnobs(resolveArgs)
  const inactive: string[] = []
  for (const id of knobs.keys()) {
    if (!values.has(id)) inactive.push(id)
  }
  return {
    knobs,
    values,
    preset: preset !== undefined && preset !== "" ? preset : undefined,
    inactive,
  }
}

/** Fold the resolved bench knobs into `base`. Convenience wrapper around
 *  `applyKnobs` so the driver doesn't have to thread the registry separately.
 *
 *  When `state.values` is empty the framework's `applyKnobs` returns `base`
 *  unchanged (proved in `apply.ts`) — this preserves the byte-identical
 *  contract for the empty-registry case. */
export const applyBenchKnobs = (
  base: AgentConfig,
  state: BenchKnobState,
  ctx: Omit<ApplyContext, "surface">,
): AgentConfig =>
  applyKnobs(base, state.knobs, state.values, {
    surface: "bench",
    ...(ctx.instance !== undefined ? { instance: ctx.instance } : {}),
    ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
  })

/** Knob-id → value extractor with strict shape guard. Returns the parsed value
 *  when the knob is active and the value matches the predicate, else
 *  `undefined`. The async bench-orchestration code (issue-hint / repro-test
 *  pre-compute) consumes this. */
export const readKnobValue = <T>(
  state: BenchKnobState,
  id: string,
  guard: (v: unknown) => v is T,
): T | undefined => {
  const kv = state.values.get(id)
  if (kv === undefined) return undefined
  return guard(kv.value) ? kv.value : undefined
}

/** Telemetry projection: id → { value, source } for the report. Plain object
 *  (not Map) so it serialises cleanly through `JSON.stringify`. */
export const knobsForReport = (
  state: BenchKnobState,
): Record<string, { value: unknown; source: string }> => {
  const out: Record<string, { value: unknown; source: string }> = {}
  for (const [id, kv] of state.values) {
    out[id] = { value: kv.value, source: kv.source }
  }
  return out
}
