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
 * STANDALONE (jun-7 F3 — decoupled): this knob works on its OWN. `session-bootstrap`
 * builds the snapshot store + response-header capture when `QUANTA_RATELIMIT_NOTICE`
 * OR `QUANTA_RATELIMIT_PROACTIVE` is on (shared SSOT predicate `ratelimitNoticeWanted`),
 * and `stream-consume` EMITS the reached-window `ratelimit_snapshot` event in BOTH
 * modes — applying the pre-request backoff `sleep` ONLY under PROACTIVE. So
 * `QUANTA_RATELIMIT_NOTICE=1` alone both captures the snapshot AND renders the
 * notice, without ever delaying the request.
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
 * DEFAULT-OFF: delegates to the SHARED `ratelimitNoticeWanted` SSOT predicate so
 * this knob's telemetry/`--help`/`/knobs` view can NEVER disagree with the actual
 * runtime gate (`runtimeConfig().ratelimitNotice` + the CLI render gate). Absent /
 * falsy (`""`/`0`/`false`/`off`/`no`) ⇒ `undefined` so the resolver falls through
 * to the next layer (NOT a silent "off"); ANY other value ⇒ `true`. One predicate,
 * three channels — no observability drift.
 */

import type { AgentConfig } from "@/agent"
import { ratelimitNoticeWanted } from "@/shared"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli"]

const parseRatelimitNotice = (raw: string | undefined): true | undefined =>
  ratelimitNoticeWanted(raw) ? true : undefined

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
  describe:
    "Transient CLI status-bar notice when the provider reports a quota window empty (P27). " +
    "Standalone — captures + renders on its own (no companion knob required).",
  source: "jun-7-gap-other-agent §23.1",
}

registerKnob(ratelimitNoticeKnob)
