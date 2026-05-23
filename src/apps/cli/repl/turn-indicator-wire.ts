import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import type { StatusBar } from "../status-bar"
import { createTurnIndicator, isIndicatorEnabled, type TurnIndicator } from "../turn-indicator"

/** Bridge `AgentEvent`s into the live turn indicator. Implements `StreamPort`
 *  so it can be teed alongside the existing recorder/stdout port — the
 *  upstream emit path is unchanged (TeeStream forwards every event to every
 *  port in order) and the indicator just sips the ones it cares about.
 *
 *  Sliced taxonomy (only events that move the indicator state):
 *    - `assistant_text` / `tool_call` ⇒ `markFirstChunk` (TTFT seam — the
 *      first emit of either is the moment the model started producing
 *      something the user can see). Idempotent on the indicator side.
 *    - `usage` ⇒ `updateUsage` with the cumulative token counts. Cost stays
 *      OFF for now (no per-model price table is wired at this surface; a
 *      future round can hand a `costUsd` in).
 *  Every other event is ignored — the indicator is purely a UX surface, not
 *  a trajectory recorder. Errors in the indicator are swallowed in place so
 *  a faulty render can never poison the recorder path. */
export const buildIndicatorPort = (ind: TurnIndicator): StreamPort => ({
  emit: (event): void => {
    try {
      if (event.type === "assistant_text" || event.type === "tool_call") {
        ind.markFirstChunk()
        return
      }
      if (event.type === "usage") {
        ind.updateUsage({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        })
      }
    } catch {
      // Intentional: an indicator failure must not surface as an emit error
      // (TeeStream would otherwise track it as a degraded record).
    }
  },
})

/** Build the (indicator, turnStream) pair for the REPL surface — extracted
 *  from `runRepl` so the host stays under biome's cognitive-complexity
 *  budget. Default-OFF byte-identical: when the indicator is disabled
 *  (non-TTY or `QUANTA_SPINNER=0|false|off|no`) `turnStream === stream`
 *  verbatim (no tee, no extra fan-out) so the existing recorder + stdout
 *  port path is byte-identical to the pre-indicator code. `intervalMs`
 *  is clamped to a finite positive integer; a bad env value (`abc`, `-5`)
 *  falls back to the 80 ms default. */
export const buildTurnIndicatorAndStream = (
  statusBar: StatusBar,
  stream: StreamPort,
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
  intervalEnv: string,
): { indicator: TurnIndicator; turnStream: StreamPort } => {
  const enabled = isIndicatorEnabled(envSource, isTTY)
  const intervalMs = Number(intervalEnv)
  const indicator = createTurnIndicator({
    statusBar,
    enabled,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 80,
  })
  if (!enabled) return { indicator, turnStream: stream }
  return { indicator, turnStream: new TeeStream([stream, buildIndicatorPort(indicator)]) }
}
