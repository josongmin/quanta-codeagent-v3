/**
 * Knobs bootstrap helper — CLI surface entry assembly for the SOTA++ knob
 * framework (`@/runner/knobs`).
 *
 * Side-effect imports below register the 13 knob records into the module-level
 * singleton registry. The registry is populated *exactly once per process* —
 * importing this file at CLI startup is what makes `knobsForSurface("cli")`,
 * `resolveKnobs`, and `applyKnobs` actually see knob records. Bench / agent
 * surfaces have their own bootstrap entries (or rely on `knobs-bench.ts`).
 *
 * The bootstrap function ITSELF is a closed-port assembly: every input
 * (`argv`, `env`, `surface`) is passed in by the caller; no `process.argv` /
 * `process.env` reads happen here. The resolver also stays closed-port — we
 * just feed it the inputs and return its read-only output map.
 *
 * `parseCliKnobsFromArgv` extracts `--knob id=val` pairs from the argv (the
 * format spec'd by the framework). Anything else passes through unchanged.
 *
 * Default-OFF: with zero `--knob` flags, no env vars set, no preset, and no
 * config file on disk, the resolved map contains ONLY knobs whose `default`
 * is defined (currently zero) — `applyKnobs(base, ..., values, ctx)` then
 * returns `=== base` byte-identical (validated by the apply.ts contract).
 */

import {
  type KnobValueMap,
  knobsForSurface,
  readKnobConfig,
  resolveKnobs,
  type Surface,
  saveKnobConfigMerged,
} from "@/runner/knobs"

// Side-effect registry population — ORDER does not matter (each knob is
// independent); we keep alphabetical to make adding/removing one a clean diff.
import "@/runner/knobs/knobs/advisor"
import "@/runner/knobs/knobs/branch-search"
import "@/runner/knobs/knobs/closeout-critic"
import "@/runner/knobs/knobs/closeout-guard"
import "@/runner/knobs/knobs/compose-authoring"
import "@/runner/knobs/knobs/hooks"
import "@/runner/knobs/knobs/issue-hint"
import "@/runner/knobs/knobs/localize-phase"
import "@/runner/knobs/knobs/lsp"
import "@/runner/knobs/knobs/mcp-tool-annotations"
import "@/runner/knobs/knobs/memory-mode"
import "@/runner/knobs/knobs/multi-voter"
import "@/runner/knobs/knobs/must-pass"
import "@/runner/knobs/knobs/network-proxy"
import "@/runner/knobs/knobs/persona"
import "@/runner/knobs/knobs/policy-merge"
import "@/runner/knobs/knobs/ratelimit-notice"
import "@/runner/knobs/knobs/repro-test"
import "@/runner/knobs/knobs/skills"
import "@/runner/knobs/knobs/subagent"
import "@/runner/knobs/knobs/task-budget"
import "@/runner/knobs/knobs/working-state"

/** Inputs to {@link bootstrapKnobs}. All env/argv reads happen at the caller
 *  (the CLI entry); this helper stays a pure data folder. */
export interface KnobsBootstrapInput {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly surface: Surface
  /** Override the user-defaults config-file path. Default: `~/.quanta/knobs.json`. */
  readonly configPath?: string
}

/** Result of {@link bootstrapKnobs} — values + the seam to mutate session
 *  overrides + re-resolve. */
export interface KnobsBootstrapOutput {
  /** Initial resolved values (CLI > session > env > config-file > preset > default). */
  readonly values: KnobValueMap
  /** Session-override bag — `/knobs set` mutates this; `/knobs save` flushes it. */
  readonly sessionOverrides: Record<string, string>
  /** Re-resolve from the latest sessionOverrides. Useful after `/knobs set`
   *  so the caller can repaint chrome with fresh values. */
  readonly resolve: () => KnobValueMap
  /** Persist the current sessionOverrides to `~/.quanta/knobs.json`. */
  readonly save: () => Promise<void>
}

/** Parse `--knob id=val` pairs out of an argv. Pairs without `=` or with empty
 *  id are silently ignored (the framework keeps unknown keys as "no value"
 *  silently — a graceful warning is a separate UX concern). */
export const parseCliKnobsFromArgv = (argv: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--knob") continue
    const next = argv[i + 1]
    if (next === undefined) {
      // Trailing `--knob` with no operand — skip.
      continue
    }
    const eq = next.indexOf("=")
    if (eq > 0) {
      const k = next.slice(0, eq)
      const v = next.slice(eq + 1)
      if (k !== "") out[k] = v
    }
    i++
  }
  return out
}

/** Assemble the CLI bootstrap inputs + return a re-resolvable surface output. */
export const bootstrapKnobs = async (input: KnobsBootstrapInput): Promise<KnobsBootstrapOutput> => {
  const knobs = knobsForSurface(input.surface)
  const cliArgs = parseCliKnobsFromArgv(input.argv)
  const sessionOverrides: Record<string, string> = {}
  const config = await readKnobConfig(input.configPath)
  const configFile = config?.user_defaults
  const presetRaw = input.env.QUANTA_KNOBS_PRESET
  const preset = typeof presetRaw === "string" && presetRaw !== "" ? presetRaw : undefined

  const doResolve = (): KnobValueMap =>
    resolveKnobs({
      surface: input.surface,
      knobs,
      cliArgs,
      sessionOverrides,
      envVars: input.env,
      // exactOptionalPropertyTypes: only spread the slot when defined.
      ...(configFile !== undefined ? { configFile } : {}),
      ...(preset !== undefined ? { preset } : {}),
    })

  const initial = doResolve()
  const save = async (): Promise<void> => {
    // Merge-on-save (jun-10 silent-failure audit #18): overlay THIS process's
    // overrides on a fresh read of the persisted user_defaults — a wholesale
    // replace from the per-process bag silently wiped prior sessions' saves.
    // NOTE(audit #18): the file is write-only in prod today; the moment
    // bootstrapKnobs gains a production reader this class escalates P2→P1
    // (docs/audits/jun-10-silent-failure-prod-audit.md).
    await saveKnobConfigMerged(sessionOverrides, input.configPath)
  }
  return { values: initial, sessionOverrides, resolve: doResolve, save }
}
