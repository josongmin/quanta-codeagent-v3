/**
 * RFC02-1 — `/ps` process panel renderer (pure).
 *
 * Renders the caller-owned background-shell inventory the `BashBgRegistry`
 * exposes via `listOwned(ownerId)`. This is a LIST-ONLY, REDACTED view: it
 * surfaces ONLY the non-sensitive lifecycle facts (short id, status glyph,
 * elapsed, exit code). It deliberately NEVER renders `command`, `cwd`, `stdout`,
 * or `stderr` — a background command line routinely carries secrets (a bearer
 * token, a `PGPASSWORD=`, a URL with creds), so the panel drops those fields at
 * the projection boundary rather than scrubbing-then-hoping (jul-15 T3).
 *
 * Pure: `now` is injected, no TTY detect, no colour — the caller adds framing.
 * A near-mirror of `agents-fleet-panel.ts` in spirit, minimal by design.
 */

/** The subset of a background-shell snapshot the panel is allowed to see. Note
 *  the ABSENCE of `command`/`cwd`/`stdout`/`stderr`: they are not part of the
 *  read model, so a future caller cannot accidentally render them through this
 *  panel. */
export interface ProcPanelRow {
  readonly id: string
  readonly status: "running" | "completed" | "killed" | "aborted"
  readonly startedAt: number
  readonly exitCode: number | null
}

/** Options: injected clock + optional bound on the number of rows rendered. */
export interface ProcPanelOptions {
  readonly now: number
  /** Max rows to render (the rest are summarised as "+N more"). Bounded output
   *  contract — a runaway registry cannot flood the panel. */
  readonly limit?: number
}

const DEFAULT_LIMIT = 50

const STATUS_GLYPH: Record<ProcPanelRow["status"], string> = {
  running: "●",
  completed: "✓",
  killed: "✗",
  aborted: "⊘",
}

/** Short, id-only render of a shell id (first 8 chars) — enough to disambiguate
 *  for a `bash_kill`/`/ps` operator without printing the full uuid. */
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id)

const fmtElapsed = (ms: number): string => {
  if (ms < 0) return "0s"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

/** Render the owned background-shell inventory as a bounded, redacted table.
 *  Deterministic: rows in the order given (the registry lists insertion-order),
 *  elapsed derived from the injected `now`. */
export const renderProcPanel = (rows: readonly ProcPanelRow[], opts: ProcPanelOptions): string => {
  const limit = opts.limit ?? DEFAULT_LIMIT
  if (rows.length === 0) {
    return "No background shells owned by this session."
  }
  const shown = rows.slice(0, limit)
  const lines = shown.map((r) => {
    const glyph = STATUS_GLYPH[r.status]
    const elapsed = fmtElapsed(opts.now - r.startedAt)
    const exit = r.exitCode === null ? "—" : String(r.exitCode)
    return `${glyph} ${shortId(r.id).padEnd(8)}  ${r.status.padEnd(9)}  ${elapsed.padStart(7)}  exit=${exit}`
  })
  const header = `Background shells (owned): ${rows.length}`
  const overflow = rows.length > shown.length ? [`  … +${rows.length - shown.length} more`] : []
  return [header, ...lines, ...overflow].join("\n")
}
