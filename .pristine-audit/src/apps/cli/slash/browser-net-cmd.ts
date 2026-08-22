/**
 * S1 (jul-03) — `/browser-net` surface.
 *
 * The `browser_network` model tool reads a bounded ring of network activity
 * (method / url / status / mime / size — METADATA only, no bodies) captured since
 * the page loaded, and `browser_snapshot` returns an accessibility tree whose
 * nodes carry element refs (locators). Both are model-invoke-only — the operator
 * had no way to SEE the last network capture or the locator summary the browser
 * tools produced.
 *
 * `/browser-net` renders the LAST captured network rows + a one-line locator
 * summary from a surface-owned holder. The producer is the browser-tool result
 * seam (a follow-up tool-layer wire); the command is REACHABLE today and shows
 * "empty" until a capture lands.
 *
 * Slice-clean: imports NO `@/tool/browser` VALUE — a duck-typed row mirror.
 */

import { notWired } from "../not-wired"
import type { SlashCommand, SlashContext } from "../slash-contract"

/** One network row — structural mirror of the browser tool's network entry
 *  (METADATA only; NO bodies or headers, matching the tool's guarantee). */
export interface BrowserNetRow {
  readonly method?: string
  readonly url: string
  readonly status?: number
  readonly mime?: string
  readonly size?: number
}

/** The last browser network-capture + locator summary. */
export interface BrowserNetSnapshot {
  /** The page url the capture came from (when known). */
  readonly pageUrl?: string
  /** The captured network rows (newest-kept, bounded by the producer). */
  readonly rows: readonly BrowserNetRow[]
  /** How many rows were dropped by the ring/row cap before this snapshot. */
  readonly dropped?: number
  /** One-line locator summary — e.g. "42 refs (12 interactive)" from the last
   *  accessibility snapshot. Absent ⇒ no snapshot captured yet. */
  readonly locatorSummary?: string
  /** Epoch-ms the capture was taken. */
  readonly at: number
}

/** Bounded, surface-owned holder for the LATEST browser capture. Only the most
 *  recent snapshot is retained (a `/browser-net` reads "the last capture"). */
export interface BrowserNetHolder {
  set(snapshot: BrowserNetSnapshot): void
  get(): BrowserNetSnapshot | undefined
}

/** Build a fresh {@link BrowserNetHolder} (single-slot, latest-wins). */
export const createBrowserNetHolder = (): BrowserNetHolder => {
  let latest: BrowserNetSnapshot | undefined
  return {
    set: (s) => {
      latest = s
    },
    get: () => latest,
  }
}

/** Format one network row: `METHOD STATUS url MIME sizeB` (each part omitted when
 *  absent). Pure. */
const formatNetRow = (r: BrowserNetRow): string => {
  const parts: string[] = []
  if (r.method !== undefined) parts.push(r.method)
  if (r.status !== undefined) parts.push(String(r.status))
  parts.push(r.url || "(no-url)")
  if (r.mime !== undefined) parts.push(r.mime)
  if (r.size !== undefined) parts.push(`${r.size}B`)
  return `  ${parts.join(" ")}`
}

/** Render the last browser network capture + locator summary. Pure. */
export const renderBrowserNet = (s: BrowserNetSnapshot): string => {
  const head = s.pageUrl !== undefined ? `Browser network — ${s.pageUrl}:` : "Browser network:"
  const lines: string[] = [head]
  if (s.dropped !== undefined && s.dropped > 0) {
    lines.push(
      `  (${s.dropped} earlier entr${s.dropped === 1 ? "y" : "ies"} dropped — buffer/row cap)`,
    )
  }
  if (s.rows.length === 0) lines.push("  (network empty)")
  else for (const r of s.rows) lines.push(formatNetRow(r))
  if (s.locatorSummary !== undefined) lines.push(`  locators: ${s.locatorSummary}`)
  return lines.join("\n")
}

/** `/browser-net` — print the last browser network-capture + locator summary.
 *  Absent slot ⇒ D-6 not-wired posture + exit 2 (hint: QUANTA_BROWSER_NETWORK). */
export const browserNetCmd: SlashCommand = {
  name: "/browser-net",
  describe: "Show the last browser network-capture + locator summary (browser_network)",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.browserNet === undefined) {
      return notWired(ctx.out, { feature: "/browser-net", gate: "QUANTA_BROWSER_NETWORK" })
    }
    if (args.length > 0) {
      ctx.err("/browser-net: takes no arguments\n")
      return 1
    }
    const snapshot = ctx.browserNet()
    if (snapshot === undefined) {
      ctx.out("/browser-net: no browser capture yet\n")
      return 0
    }
    ctx.out(`${renderBrowserNet(snapshot)}\n`)
    return 0
  },
}
