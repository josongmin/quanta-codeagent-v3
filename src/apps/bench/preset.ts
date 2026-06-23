import { KNOB_PRESETS, presetRequiresLiveLspGrounding } from "@/runner/knobs"
import { gateOn } from "@/shared"

export const CURRENT_BENCH_BASE_PRESET = "agentless-v3-thin-strict"
export const V5_ADAPTIVE_PRESET = "agentless-v5-thin-and-expanded"
export { presetRequiresLiveLspGrounding }

/** Is the v5 thin-first ADAPTIVE controller live for this run? Default-OFF and
 *  STRICT opt-in: true ONLY when the resolved preset is the v5 preset AND
 *  `QUANTA_BENCH_V5_ADAPTIVE` is explicitly on. Without the opt-in the preset is
 *  inert (runs as its thin-strict base posture) — so the LLM brain never engages
 *  until the operator opts in (the oracle-measurement wave gate). */
export const v5AdaptiveEnabled = (args: {
  readonly preset: string | undefined
  readonly envVars: Record<string, string | undefined>
}): boolean =>
  args.preset === V5_ADAPTIVE_PRESET && gateOn(args.envVars, "QUANTA_BENCH_V5_ADAPTIVE")

const asNonEmpty = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Resolve the EFFECTIVE bench execution preset at the composition root.
 *
 * Precedence intentionally keeps explicit env selectors authoritative so a
 * shell-exported experiment arm is not silently clobbered by a CLI default:
 *   1. `QUANTA_BENCH_PRESET=<name>`      — canonical selector.
 *   2. `QUANTA_BENCH_SOTA=1`             — back-compat alias for agentless-v1.
 *   3. `QUANTA_KNOBS_PRESET=<name>`      — legacy framework spelling.
 *   4. `--preset <name>`                 — CLI convenience for bench entrypoints.
 *   5. CURRENT base profile              — the structural default for live runs.
 */
export const resolveBenchExecutionPreset = (args: {
  readonly envVars: Record<string, string | undefined>
  readonly argvPreset?: string | undefined
}): string => {
  const envPreset = asNonEmpty(args.envVars.QUANTA_BENCH_PRESET)
  if (envPreset !== undefined) return envPreset
  if (gateOn(args.envVars, "QUANTA_BENCH_SOTA")) return "agentless-v1"
  const legacyPreset = asNonEmpty(args.envVars.QUANTA_KNOBS_PRESET)
  if (legacyPreset !== undefined) return legacyPreset
  return asNonEmpty(args.argvPreset) ?? CURRENT_BENCH_BASE_PRESET
}

/** Seed `QUANTA_BENCH_PRESET` only when the operator did NOT already select a
 * posture through env. This keeps local `bench run` / `index.ts` honest by
 * default while preserving explicit `QUANTA_BENCH_SOTA` / `QUANTA_KNOBS_PRESET`
 * experiments unchanged. */
export const seedBenchExecutionPreset = (
  env: Record<string, string | undefined>,
  argvPreset?: string,
): void => {
  const envPreset = asNonEmpty(env.QUANTA_BENCH_PRESET)
  if (envPreset !== undefined) {
    env.QUANTA_BENCH_PRESET = envPreset
    return
  }
  if (gateOn(env, "QUANTA_BENCH_SOTA")) return
  if (asNonEmpty(env.QUANTA_KNOBS_PRESET) !== undefined) return
  env.QUANTA_BENCH_PRESET = resolveBenchExecutionPreset({ envVars: env, argvPreset })
}

/** Shared preset-list rendering for both legacy `index.ts --list-presets` and
 * `quanta-bench presets`, so wording/content cannot drift across entrypoints. */
export const renderBenchPresetListLines = (): string[] => [
  "Bench presets — select with QUANTA_BENCH_PRESET=<name> (value, not on/off).",
  `Default live execution preset: ${CURRENT_BENCH_BASE_PRESET}.`,
  "Individual QUANTA_BENCH_* env vars override a preset's values.",
  "QUANTA_BENCH_SOTA=1 is a back-compat alias for agentless-v1.",
  "",
  ...Object.entries(KNOB_PRESETS).map(([name, knobs]) => {
    const body = Object.entries(knobs)
      .map(([id, value]) => `${id}=${value}`)
      .join(", ")
    return `  ${name.padEnd(16)} ${body === "" ? "(no-op baseline)" : body}`
  }),
]
