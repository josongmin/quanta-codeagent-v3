/**
 * Knob: `ratelimit-notice` — P27 transient rate-limit quota notice (CLI surface).
 *
 * When ON, the CLI REPL tees a {@link buildRatelimitNoticePort} (see
 * `src/apps/cli/ratelimit-notice.ts`) onto the turn stream so a `ratelimit_snapshot`
 * AgentEvent paints a transient "한도 N · resets …" line on the bottom status bar.
 * The "when to surface" decision is NOT a new percent: it reuses the slice's
 * already-computed empty-bucket (reached) signal — `proactiveDelayMs(snapshot) > 0`
 * from `src/llm/ratelimit-snapshot/policy.ts`, i.e. the provider literally reports
 * a window with `remaining <= 0`. No quanta-invented threshold.
 *
 * SURFACE = `cli` only: it drives a terminal-status-bar render, which has no
 * meaning on bench / agent-* surfaces. Like the spinner / pills knobs the actual
 * gate is read by `readCliFeatureConfig` (`src/apps/cli/repl/cli-feature-config.ts`)
 * straight off the env; this knob record exists for the SSOT registry (`--help`
 * listing, knob telemetry, `/knobs` surface). Its `apply` is therefore a PURE
 * no-op — it never mutates the AgentConfig, preserving the byte-identical
 * default-OFF contract (`applyKnobs(base, …) === base` when this is the only
 * resolved knob).
 *
 * DEFAULT-OFF: STRICT truthy gate — only `"1"`, `"on"`, `"true"` parse to `true`.
 * Unset / falsy / empty / garbage ⇒ `undefined` so the resolver falls through to
 * the next layer (NOT a silent "off"), exactly like `working-state`. No heuristics.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli"]
const TRUTHY = new Set(["1", "on", "true"])

const parseRatelimitNotice = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? true : undefined
}

/** PURE no-op: this is a CLI surface-render flag, not an AgentConfig knob. The
 *  config is returned UNCHANGED so the byte-identical contract holds. */
const applyRatelimitNotice = (cfg: AgentConfig): AgentConfig => cfg

export const ratelimitNoticeKnob: Knob<true> = {
  id: "ratelimit-notice",
  envKey: "QUANTA_RATELIMIT_NOTICE",
  category: "hint",
  surfaces: SURFACES,
  parse: parseRatelimitNotice,
  apply: applyRatelimitNotice,
  describe: "Transient CLI status-bar notice when the provider reports a quota window empty (P27)",
  source: "jun-7-gap-other-agent §23.1",
}

registerKnob(ratelimitNoticeKnob)
