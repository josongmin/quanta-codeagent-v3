import { emitOperatorNotice } from "@/shared"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { buildRatelimitNoticePort } from "../../ratelimit-notice"
import type { StatusBar } from "../../status-bar"
import { createTurnIndicator, type TurnIndicator } from "../../turn-indicator"
import type { CliFeatureConfig } from "../cli-feature-config"
import { buildIndicatorPort, type IndicatorUsageObserver } from "./indicator-stream-port"

/** Build the (indicator, turnStream) pair for the REPL surface — extracted
 *  from `runRepl` so the host stays under biome's cognitive-complexity
 *  budget. Default-OFF byte-identical: when the indicator is disabled
 *  (non-TTY or `QUANTA_SPINNER=0|false|off|no`) `turnStream === stream`
 *  verbatim (no tee, no extra fan-out) so the existing recorder + stdout
 *  port path is byte-identical to the pre-indicator code. `intervalMs`
 *  is clamped to a finite positive integer; a bad env value (`abc`, `-5`)
 *  falls back to the 80 ms default.
 *
 *  P27 — when `featureCfg.ratelimitNotice.enabled` (default-OFF
 *  `QUANTA_RATELIMIT_NOTICE`), the rate-limit notice port is teed onto the
 *  SAME `statusBar` so a `ratelimit_snapshot` event paints a transient quota
 *  notice. The two gates are independent: the tee is allocated when EITHER the
 *  indicator OR the notice is on. When BOTH are off, `turnStream === stream`
 *  verbatim (no tee, byte-identical to the pre-P27 path). The notice port's own
 *  emit swallows render errors, so it never poisons the recorder leg.
 *
 *  S3 (jul-03) — `usageObserver` (optional) is threaded onto the indicator
 *  port so a live `usage` AgentEvent's `reasoningTokens` split feeds the
 *  `/context` gauge holder. It rides the EXISTING indicator port (no new tee
 *  fan-out), so the byte-identical default-OFF contract is unchanged: when the
 *  indicator is disabled the port is never allocated and the observer is never
 *  called; when the observer is absent the port behaves exactly as before. */
export const buildTurnIndicatorAndStream = (
  featureCfg: CliFeatureConfig,
  statusBar: StatusBar,
  stream: StreamPort,
  usageObserver?: IndicatorUsageObserver,
): { indicator: TurnIndicator; turnStream: StreamPort } => {
  const { enabled, intervalMs } = featureCfg.turnIndicator
  const indicator = createTurnIndicator({ statusBar, enabled, intervalMs })

  // Collect the surface ports to tee alongside the upstream recorder/stdout
  // stream. Order is preserved by TeeStream (the upstream `stream` stays first
  // so its observers see every event before any UX surface).
  const extraPorts: StreamPort[] = []
  if (enabled) extraPorts.push(buildIndicatorPort(indicator, usageObserver))
  // Optional-chained: a feature config assembled before P27 (or a partial test
  // stub) has no `ratelimitNotice` block ⇒ treated as OFF (no tee), preserving
  // the byte-identical default-OFF contract.
  if (featureCfg.ratelimitNotice?.enabled === true) {
    extraPorts.push(buildRatelimitNoticePort(statusBar))
  }

  if (extraPorts.length === 0) return { indicator, turnStream: stream }
  // WS-G (UUX-1-18) — a silently-swallowed port failure (recorder leg OR a UX
  // port) now produces ONE latched operator notice instead of an invisible
  // `degraded()` record nobody reads on this surface.
  return {
    indicator,
    turnStream: new TeeStream([stream, ...extraPorts], {
      onFirstDegrade: (record) => {
        emitOperatorNotice({
          severity: "warn",
          source: "stream",
          message: `a turn-stream sink degraded: ${record.reason}`,
          hint: "some events may be missing from the recorder or UX chrome",
        })
      },
    }),
  }
}
