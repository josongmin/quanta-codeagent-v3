import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import {
  createTurnSummary,
  isTurnSummaryEnabled,
  isTurnSummaryVerbose,
  type TurnSummaryCollector,
} from "../turn-summary"

/** Build the turn-summary collector + tee-wrap the upstream stream. Default-ON
 *  for TTY surfaces (auto-OFF on pipes/redirects) so the operator sees a
 *  per-turn signal box (tools / verify-guard / compaction / memory / recovery)
 *  WITHOUT opting in. Explicit `QUANTA_TURN_SUMMARY=0|false|off|no` reverts to
 *  the pre-summary code path (`{collector: disabled, stream}` ⇒ the renderer
 *  returns `""` and we write nothing).
 *
 *  Byte-identical: when the collector is disabled the returned `stream`
 *  reference is the literal input — no TeeStream allocated, no extra fan-out,
 *  so the existing recorder/stdout/indicator port path is identical to today's. */
export const buildTurnSummaryAndStream = (
  stream: StreamPort,
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): { collector: TurnSummaryCollector; stream: StreamPort } => {
  const enabled = isTurnSummaryEnabled(envSource, isTTY)
  const verbose = isTurnSummaryVerbose(envSource)
  const collector = createTurnSummary({ enabled, verbose })
  if (!enabled) return { collector, stream }
  return { collector, stream: new TeeStream([stream, collector.asStreamPort()]) }
}
