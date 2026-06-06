import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { buildRatelimitNoticePort } from "../../ratelimit-notice"
import type { StatusBar } from "../../status-bar"
import { createTurnIndicator, type TurnIndicator } from "../../turn-indicator"
import type { CliFeatureConfig } from "../cli-feature-config"
import { buildIndicatorPort } from "./indicator-stream-port"

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
 *  emit swallows render errors, so it never poisons the recorder leg. */
export const buildTurnIndicatorAndStream = (
  featureCfg: CliFeatureConfig,
  statusBar: StatusBar,
  stream: StreamPort,
): { indicator: TurnIndicator; turnStream: StreamPort } => {
  const { enabled, intervalMs } = featureCfg.turnIndicator
  const indicator = createTurnIndicator({ statusBar, enabled, intervalMs })

  // Collect the surface ports to tee alongside the upstream recorder/stdout
  // stream. Order is preserved by TeeStream (the upstream `stream` stays first
  // so its observers see every event before any UX surface).
  const extraPorts: StreamPort[] = []
  if (enabled) extraPorts.push(buildIndicatorPort(indicator))
  // Optional-chained: a feature config assembled before P27 (or a partial test
  // stub) has no `ratelimitNotice` block ⇒ treated as OFF (no tee), preserving
  // the byte-identical default-OFF contract.
  if (featureCfg.ratelimitNotice?.enabled === true) {
    extraPorts.push(buildRatelimitNoticePort(statusBar))
  }

  if (extraPorts.length === 0) return { indicator, turnStream: stream }
  return { indicator, turnStream: new TeeStream([stream, ...extraPorts]) }
}
