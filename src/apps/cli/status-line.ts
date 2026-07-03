/**
 * Surface-agnostic context-usage formatter (Cursor Canvas UsageBar parity).
 *
 * Renders the segmented, multi-category `/context` gauge — a fixed-width ASCII
 * bar plus a per-category legend — suitable for a CLI prompt prefix, a Tauri
 * sidebar, a Web REPL header, or any other surface. Pure functions, no I/O,
 * NO `@/agent` import. The only allowed imports here are `node:*` (currently
 * none needed), so these helpers can be lifted verbatim into a future Tauri /
 * Web bundle.
 *
 * (Historical note: a single-bar `formatContextUsage(used, max, model)` variant
 * used to live here as the "status line default". It had ZERO production
 * callers — the status line was never composed at the render root — so it was
 * deleted (jul-03 S3). The segmented view below is the sole renderer.)
 */

/** Empty bar cell. */
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

// ── Track D: segmented multi-category usage bar (Cursor UsageBar shape) ──────
//
// Surfaced via the `/context` slash command.
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
  /**
   * S3 (jul-03) — OpenAI-Responses-ONLY reasoning-token split (portion of the
   * turn's OUTPUT tokens the model spent on hidden reasoning). Rendered as a
   * SEPARATE legend annotation, NOT a bar segment: reasoning is output-side, so
   * folding it into the input-context `total` / bar would misrepresent the
   * window. OMITTED for providers with no split (Anthropic bills thinking as
   * ordinary output) — the annotation then simply does not appear (no synthetic
   * value). `0` is treated as "nothing to show" and also omitted.
   */
  readonly reasoningTokens?: number
}

/** Percentage (0–100, rounded) of the window consumed. Never NaN. */
const viewPercent = (b: SegmentedUsageView): number => {
  if (!(b.max > 0)) return 0
  return Math.min(100, Math.round((b.total / b.max) * 100))
}

/** S3 (jul-03) — codex-rs `% context left` gauge value: the REMAINING share of
 *  the window (100 − used%), clamped 0..100. Never NaN. Codex renders the head
 *  as `Context N% left`; a full window is `0% left`, a fresh one `100% left`. */
const viewPercentLeft = (b: SegmentedUsageView): number => 100 - viewPercent(b)

/** S3 — raw tokens left in the window (max − total, floored at 0). Feeds the
 *  codex `You have N tokens left in this context window.` annotation. */
const viewTokensLeft = (b: SegmentedUsageView): number => Math.max(0, b.max - b.total)

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

  // S3 (jul-03) — codex-rs `Context N% left` head (REMAINING, not used). The
  // token counter is kept as `used/max` for the segment legend that follows, but
  // the headline value now matches codex's `% context left` phrasing so a user
  // reads "how much room is left" at a glance (parity with codex-rs
  // `bottom_pane`'s `Context N% left`).
  const left = viewPercentLeft(b)
  const head = `[${bar}] ${formatTokens(b.total)}/${formatTokens(b.max)} · Context ${left}% left${
    b.model !== undefined && b.model !== "" ? ` · ${b.model}` : ""
  }`

  const lines: string[] = [head]
  // S3 — codex `You have N tokens left in this context window.` annotation.
  lines.push(`  ${formatTokens(viewTokensLeft(b))} tokens left in this context window`)
  for (let i = 0; i < b.segments.length; i++) {
    const s = b.segments[i]
    if (s === undefined) continue
    const glyph = SEGMENT_GLYPH[i % SEGMENT_GLYPH.length] ?? "█"
    const share = b.total > 0 ? Math.round((s.tokens / b.total) * 100) : 0
    lines.push(`  ${glyph} ${s.id.padEnd(12)} ${formatTokens(s.tokens)} (${share}%)`)
  }
  // S3 (jul-03): reasoning-token split (OpenAI-Responses-only) as a distinct
  // annotation — OUTPUT-side, so it is NOT a bar segment and is NOT summed into
  // the input-context total above. Absent/0 ⇒ omitted (Anthropic byte-identical,
  // no synthetic value).
  if (b.reasoningTokens !== undefined && b.reasoningTokens > 0) {
    lines.push(`  · ${"Reasoning".padEnd(12)} ${formatTokens(b.reasoningTokens)} (output)`)
  }
  return lines.join("\n")
}
