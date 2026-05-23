import { buildCostDashboard, renderDashboardText, type StructuredLogger } from "@/observability"
import type { StatusBar } from "../status-bar"

/** Render the per-turn cost+cache dashboard to stderr + log a structured
 *  snapshot. No-op when metrics are off (default). Extracted from the
 *  in-loop block so each closure stays within the biome cognitive-complexity
 *  budget. ADR-0085. */
export const renderTurnDashboard = (
  metrics: { snapshot: () => Parameters<typeof buildCostDashboard>[0] } | undefined,
  model: string,
  slog: StructuredLogger,
): void => {
  if (!metrics) return
  const snap = metrics.snapshot()
  slog.info("metrics.snapshot", { snapshot: snap })
  process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
}

/** Print a turn-level error inline + flash the status bar. Used by the
 *  interactive wrapTurn to keep the REPL alive when a single turn throws.
 *  Extracted to keep wrapTurn under the biome cognitive-complexity budget. */
export const renderTurnError = (e: unknown, statusBar: StatusBar): void => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
  statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
}
