/**
 * Surface-agnostic context-usage formatter (Claude Desktop 1.7196.3
 * `getContextUsage` parity).
 *
 * Renders a single-line ASCII progress bar suitable for a CLI prompt prefix,
 * a Tauri sidebar, a Web REPL header, or any other surface — pure function,
 * no I/O, NO `@/agent` import. The only allowed imports here are `node:*`
 * (currently none needed), so this helper can be lifted verbatim into a
 * future Tauri / Web bundle.
 *
 * Format: `[<bar>] <used>/<max> (<pct>%) · <model>`
 *
 * Examples:
 *   formatContextUsage(50_000,  200_000, "claude-sonnet-4-5")
 *     → "[█████░░░░░░░░░░░░░░░] 50.0k/200k (25%) · claude-sonnet-4-5"
 *
 *   formatContextUsage(250_000, 200_000, "claude-sonnet-4-5")
 *     → "[████████████████████] 250k/200k (125%!) · claude-sonnet-4-5"
 *      (saturated bar + `!` oversize indicator)
 *
 *   formatContextUsage(50_000, 200_000)
 *     → "[█████░░░░░░░░░░░░░░░] 50.0k/200k (25%) · unknown"
 *
 * Bar contract:
 *   - Exactly 20 cells, `█` = filled, `░` = empty (5% per cell).
 *   - 0% ⇒ 20 empty cells; 100% ⇒ 20 filled cells.
 *   - >100% ⇒ bar saturates at 20 filled, percentage is suffixed with `!`.
 *   - Negative `used` ⇒ clamps to 0%.
 *   - `max <= 0` ⇒ bar empty, pct rendered as `?` (never NaN/Infinity).
 */

/** Width of the rendered bar in cells. 5% per cell — keep in sync if changed. */
const BAR_WIDTH = 20

const FILLED_CELL = "█" // █
const EMPTY_CELL = "░" // ░

/** Format a token count: `523`, `50.0k`, `200k`.
 *
 *  Under 1000 ⇒ raw integer. 1000..99,999 ⇒ one decimal (`50.0k`, `23.5k`).
 *  ≥ 100,000 ⇒ integer-only (`200k`, `128k`) — at that magnitude the .0 noise
 *  outweighs precision. */
const formatTokens = (n: number): string => {
  if (n < 1000) return String(Math.max(0, Math.trunc(n)))
  const k = n / 1000
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
}

/** Render the ASCII bar; `pct` in [0, 1+]. Saturates at full above 100%. */
const renderBar = (pct: number): string => {
  if (!Number.isFinite(pct) || pct <= 0) {
    return `[${EMPTY_CELL.repeat(BAR_WIDTH)}]`
  }
  const cells = Math.min(BAR_WIDTH, Math.round(pct * BAR_WIDTH))
  return `[${FILLED_CELL.repeat(cells)}${EMPTY_CELL.repeat(BAR_WIDTH - cells)}]`
}

/** Trim + fall back to `"unknown"` for missing/blank model names. */
const formatModel = (model: string | undefined): string => {
  if (model === undefined) return "unknown"
  const trimmed = model.trim()
  return trimmed === "" ? "unknown" : trimmed
}

/**
 * Format a one-line context-usage string. Pure function, no I/O.
 *
 * @param used  tokens consumed so far (negative ⇒ clamped to 0)
 * @param max   context window size for the active model (≤0 ⇒ degraded `?` pct)
 * @param model optional model id; blank/missing ⇒ "unknown"
 */
export const formatContextUsage = (used: number, max: number, model?: string): string => {
  const modelLabel = formatModel(model)

  // Degraded path: unknown context size. Bar empty, pct "?", no division.
  if (!(max > 0) || !Number.isFinite(max)) {
    const usedSafe = Number.isFinite(used) && used > 0 ? used : 0
    return `${renderBar(0)} ${formatTokens(usedSafe)}/? (?) · ${modelLabel}`
  }

  const usedClamped = Number.isFinite(used) && used > 0 ? used : 0
  const ratio = usedClamped / max
  const pctNum = Math.round(ratio * 100)
  const oversize = ratio > 1
  const pctLabel = oversize ? `${pctNum}%!` : `${pctNum}%`

  return `${renderBar(ratio)} ${formatTokens(usedClamped)}/${formatTokens(max)} (${pctLabel}) · ${modelLabel}`
}
