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

// ── Track D: segmented multi-category usage bar (Cursor UsageBar shape) ──────
//
// Additive + default-OFF: the single-bar `formatContextUsage` above is left
// byte-identical and remains the status-line default. This view is surfaced
// only via the `/context` slash command.
//
// The bar has a FIXED width (`SEGMENTED_BAR_CELLS`) so it is stable regardless
// of how many categories are present. Each category occupies a number of cells
// proportional to its token share (largest-remainder ⇒ cells sum EXACTLY to
// the bar width), with a distinct fill glyph per category so segments are
// visible without ANSI color.

/**
 * Structural shape the renderer needs from a context-usage breakdown. Declared
 * locally (NOT imported from `@/agent`) to keep this file's slice fence intact —
 * the header forbids `@/agent` imports so the helper stays liftable into a
 * Tauri / Web bundle. `@/agent/context/usage-breakdown.ContextUsageBreakdown`
 * is structurally assignable to this. */
export interface SegmentedUsageView {
  readonly segments: ReadonlyArray<{ readonly id: string; readonly tokens: number }>
  readonly total: number
  readonly max: number
  readonly model?: string
}

/** Percentage (0–100, rounded) of the window consumed. Never NaN. */
const viewPercent = (b: SegmentedUsageView): number => {
  if (!(b.max > 0)) return 0
  return Math.min(100, Math.round((b.total / b.max) * 100))
}

/** Fixed cell width of the segmented bar. */
export const SEGMENTED_BAR_CELLS = 24

/** Per-segment fill glyph (rotates by segment index; deterministic). */
const SEGMENT_GLYPH = ["█", "▓", "▒", "▆", "▅", "▄", "▃"] as const

/**
 * Allocate `cells` across segments weighted by token count, summing EXACTLY to
 * `cells` (largest-remainder). Stable tie-break by index ⇒ deterministic.
 */
const allocateCells = (tokens: readonly number[], total: number, cells: number): number[] => {
  if (total <= 0) return tokens.map(() => 0)
  const exact = tokens.map((t) => (t / total) * cells)
  const floored = exact.map((x) => Math.floor(x))
  let remainder = cells - floored.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = [...floored]
  for (const { i } of order) {
    if (remainder <= 0) break
    out[i] = (out[i] ?? 0) + 1
    remainder -= 1
  }
  return out
}

/**
 * Render a segmented, multi-category context-usage view: a fixed-width bar
 * followed by one legend row per present category. Pure function, no I/O.
 *
 * Example (truncated):
 *   `[███████▓▓▓▒▒░░░░░░░░░░░░░] 76.8k/120k · 64% Full · gpt-5`
 *   `  █ System        40.0k (52%)`
 *   `  ▓ Rules         20.0k (26%)`
 *   `  ▒ Conversation  16.8k (22%)`
 */
export const formatSegmentedUsage = (b: SegmentedUsageView): string => {
  const pct = viewPercent(b)
  const cellsPerSegment = allocateCells(
    b.segments.map((s) => s.tokens),
    b.total,
    SEGMENTED_BAR_CELLS,
  )
  let used = 0
  let bar = ""
  for (let i = 0; i < b.segments.length; i++) {
    const cells = cellsPerSegment[i] ?? 0
    used += cells
    bar += (SEGMENT_GLYPH[i % SEGMENT_GLYPH.length] ?? "█").repeat(cells)
  }
  bar += EMPTY_CELL.repeat(Math.max(0, SEGMENTED_BAR_CELLS - used))

  const fullness = pct >= 100 ? "Full" : `${pct}% Full`
  const head = `[${bar}] ${formatTokens(b.total)}/${formatTokens(b.max)} · ${fullness}${
    b.model !== undefined && b.model !== "" ? ` · ${b.model}` : ""
  }`

  const lines: string[] = [head]
  for (let i = 0; i < b.segments.length; i++) {
    const s = b.segments[i]
    if (s === undefined) continue
    const glyph = SEGMENT_GLYPH[i % SEGMENT_GLYPH.length] ?? "█"
    const share = b.total > 0 ? Math.round((s.tokens / b.total) * 100) : 0
    lines.push(`  ${glyph} ${s.id.padEnd(12)} ${formatTokens(s.tokens)} (${share}%)`)
  }
  return lines.join("\n")
}
