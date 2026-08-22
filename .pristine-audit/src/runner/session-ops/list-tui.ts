/**
 * `quanta session list` rich TUI renderer (Codex-inspired).
 *
 * Pure-string renderer + filter pipeline. Lives in the surface-agnostic
 * `@/runner/session-ops` slice — colour comes through `@/ui/ui-helpers`
 * (gated on `NO_COLOR` / `FORCE_COLOR` / TTY at the helper level), every
 * I/O effect remains the caller's responsibility (the dispatcher writes
 * the returned string to `deps.out`).
 *
 * Two formats:
 *
 *  - `rich` (default when stdout is a TTY) — status badges (`◐/◇/◯/✗`),
 *    inline git fingerprint `[branch]`, relative age, turn count, token
 *    estimate, archived split with a thin separator, footer summary.
 *  - `plain` (back-compat) — byte-identical to the prior
 *    `ID/TITLE/CWD/LAST/ARCH` header + rows. ALL existing tests that
 *    `expect(c.out).toContain(id)` keep passing because the rich format
 *    also surfaces the (truncated) id.
 *
 * Filters (`--cwd`, `--branch`, `--archived`, `--last <N>`) and sort
 * (`--sort recent|title|size`) are applied here. The dispatcher does
 * argv parsing and hands us typed `SessionListOptions`.
 *
 * Token estimation is intentionally imprecise — Codex shows the same
 * "~X tok" affordance without parsing the entire envelope per render.
 * We use the JSONL envelope file size ÷ 4 as a cheap upper bound when
 * the file exists; otherwise we estimate from the snapshot message
 * count (caller may pass `entries[i].totalTokens` if it already has a
 * precise value from elsewhere — we just display whatever it gives).
 */

import { stat } from "node:fs/promises"
import type { SessionMeta } from "@/session"
import { sessionEnvelopePath, sessionFilePath } from "@/session"
import { byteCompare } from "@/shared"
import { bold, cyan, dim, gray, green, yellow } from "@/ui"

export interface SessionListEntry {
  /** Underlying session metadata (id/title/cwd/timestamps/git fingerprint). */
  meta: SessionMeta
  /** Approximate token total — caller may supply, otherwise renderer
   *  treats as unknown and omits the `~N tok` column. */
  totalTokens?: number
  /** Number of turns in the snapshot transcript. Omitted when unknown. */
  turns?: number
  /** Archive status (mirrors `meta.archived` — kept as a separate field
   *  so the caller can override for "include archived but render dim"
   *  presentations without mutating the meta). */
  archived: boolean
  /** Seconds since `meta.lastTouched`. Caller computes this with its own
   *  clock so tests can pass a stable value. */
  ageSeconds: number
}

export interface SessionListOptions {
  /** Render format. `plain` is the byte-identical pre-TUI fallback. */
  format?: "rich" | "plain"
  /** Include archived entries in output. Default `false`. */
  showArchived?: boolean
  /** Substring match against `meta.cwd`. */
  filterCwd?: string
  /** Exact-or-substring match against `meta.gitBranch`. */
  filterBranch?: string
  /** Cap output to the top-N most recent entries (after filtering). */
  lastN?: number
  /** Sort order. `recent` = lastTouched desc (default), `title` = A→Z,
   *  `size` = turns desc (largest first). */
  sortBy?: "recent" | "title" | "size"
}

// ────────────────────────────────────────────────────────────────────
// Token estimation
// ────────────────────────────────────────────────────────────────────

/** Compute an approximate token total from on-disk artifacts. Prefers the
 *  JSONL envelope (richer signal — every turn appended), falls back to
 *  the snapshot JSON. Returns `undefined` when neither file is reachable
 *  so the renderer can skip the column. */
export const estimateTokens = async (id: string): Promise<number | undefined> => {
  // Envelope first (per-turn append rail) — its size scales with turns.
  try {
    const s = await stat(sessionEnvelopePath(id))
    if (s.isFile() && s.size > 0) return Math.round(s.size / 4)
  } catch {
    /* file may not exist — try snapshot */
  }
  try {
    const s = await stat(sessionFilePath(id))
    if (s.isFile() && s.size > 0) return Math.round(s.size / 4)
  } catch {
    /* both gone — give up */
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────
// Filter / sort pipeline
// ────────────────────────────────────────────────────────────────────

/** Apply the filter + sort + cap pipeline. Returns the (mutated copy of
 *  the) entries the renderer will draw. Exported so tests can verify
 *  ordering and filtering without scraping the string output. */
export const applyListPipeline = (
  entries: readonly SessionListEntry[],
  opts: SessionListOptions,
): SessionListEntry[] => {
  let list: SessionListEntry[] = entries.slice()

  if (opts.showArchived !== true) {
    list = list.filter((e) => !e.archived)
  }
  if (opts.filterCwd !== undefined && opts.filterCwd !== "") {
    const needle = opts.filterCwd
    list = list.filter((e) => e.meta.cwd.includes(needle))
  }
  if (opts.filterBranch !== undefined && opts.filterBranch !== "") {
    const needle = opts.filterBranch
    list = list.filter(
      (e) => typeof e.meta.gitBranch === "string" && e.meta.gitBranch.includes(needle),
    )
  }

  const sortKey = opts.sortBy ?? "recent"
  if (sortKey === "title") {
    list.sort((a, b) => byteCompare(a.meta.title, b.meta.title))
  } else if (sortKey === "size") {
    list.sort((a, b) => (b.turns ?? 0) - (a.turns ?? 0))
  } else {
    // recent (default): newest lastTouched first.
    list.sort((a, b) => b.meta.lastTouched - a.meta.lastTouched)
  }

  if (opts.lastN !== undefined && opts.lastN > 0 && list.length > opts.lastN) {
    list = list.slice(0, opts.lastN)
  }

  return list
}

// ────────────────────────────────────────────────────────────────────
// Render helpers
// ────────────────────────────────────────────────────────────────────

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Coarse relative time — same vocabulary the dispatcher already used
 *  ("2h", "1d") so the rich badge slots in without surprise. */
const relAge = (sec: number): string => {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))}s ago`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Pick the status glyph + colour:
 *  - archived → `✗` gray
 *  - within 24h → `◐` green (idle/active)
 *  - within 7d  → `◇` cyan (recent)
 *  - older      → `◯` yellow-dim (cold) */
const statusBadge = (entry: SessionListEntry): string => {
  if (entry.archived) return gray("✗")
  if (entry.ageSeconds < 24 * 3600) return green("◐")
  if (entry.ageSeconds < 7 * 24 * 3600) return cyan("◇")
  return yellow("◯")
}

/** Render the inline git fingerprint as `[origin:branch]`. When neither
 *  field is captured we return an empty string so the row collapses
 *  cleanly. `origin` collapses to the host-less repo slug when an URL
 *  is present, or the branch's "main" fallback otherwise. */
const gitBadge = (meta: SessionMeta): string => {
  const branch = meta.gitBranch
  if (typeof branch !== "string" || branch.length === 0) return ""
  // Try to derive a short "origin" tag from the URL — `github.com:user/repo` → `repo`,
  // or `https://github.com/user/repo.git` → `repo`. Best-effort; fall through.
  const url = meta.gitOriginUrl
  let origin = "git"
  if (typeof url === "string" && url.length > 0) {
    const m = url.match(/[/:]([^/:]+?)(?:\.git)?\/?$/)
    if (m && typeof m[1] === "string") origin = m[1]
  }
  return dim(`[${origin}:${truncate(branch, 24)}]`)
}

/** Compact id presentation — Codex shows ~6 chars; we keep 6 for parity. */
const shortId = (id: string): string => (id.length > 6 ? id.slice(0, 6) : id.padEnd(6))

/** Format `~12.3k` / `~123` token counts. */
const fmtTokens = (n: number): string => {
  if (n < 1000) return `~${n} tok`
  return `~${(n / 1000).toFixed(1)}k tok`
}

// ────────────────────────────────────────────────────────────────────
// Renderers
// ────────────────────────────────────────────────────────────────────

const renderPlain = (entries: readonly SessionListEntry[]): string => {
  if (entries.length === 0) return "(no sessions)\n"
  let out = `${"ID".padEnd(38)}  ${"TITLE".padEnd(24)}  ${"CWD".padEnd(40)}  ${"LAST".padEnd(6)}  ARCH\n`
  for (const e of entries) {
    const m = e.meta
    out += `${truncate(m.id, 38).padEnd(38)}  ${truncate(m.title, 24).padEnd(24)}  ${truncate(m.cwd, 40).padEnd(40)}  ${relAge(e.ageSeconds).padEnd(6)}  ${m.archived ? "yes" : "no"}\n`
  }
  return out
}

/** Render the rich (Codex-inspired) view. Static — no interactive
 *  cursor handling, no escape sequences beyond colour. */
const renderRich = (entries: readonly SessionListEntry[], opts: SessionListOptions): string => {
  const active = entries.filter((e) => !e.archived)
  const archived = entries.filter((e) => e.archived)

  if (entries.length === 0) {
    return "(no sessions)\n"
  }

  const header = bold(
    `─ Quanta sessions (${active.length} active${archived.length > 0 ? `, ${archived.length} archived` : ""}) `,
  )
  const lines: string[] = [`${header}${dim("─".repeat(Math.max(0, 70 - header.length)))}`]

  const renderRow = (e: SessionListEntry): string[] => {
    const m = e.meta
    const badge = statusBadge(e)
    const id = e.archived ? gray(shortId(m.id)) : bold(shortId(m.id))
    const title = e.archived ? gray(truncate(m.title, 30)) : truncate(m.title, 30)
    const git = gitBadge(m)
    const segments: string[] = []
    segments.push(`${badge}  ${id}  ${title.padEnd(30)}`)
    if (git !== "") segments.push(`  ${git.padEnd(28)}`)
    else segments.push(`  ${"".padEnd(28)}`)
    segments.push(` ${dim("·")} ${relAge(e.ageSeconds)}`)
    if (typeof e.turns === "number") segments.push(` ${dim("·")} ${e.turns} turns`)
    if (typeof e.totalTokens === "number") segments.push(` ${dim("·")} ${fmtTokens(e.totalTokens)}`)
    const row1 = `  ${segments.join("")}`
    const row2 = `     ${dim(truncate(m.cwd, 62))}`
    return [row1, row2]
  }

  for (const e of active) lines.push(...renderRow(e))

  if (archived.length > 0) {
    lines.push(`  ${dim("┄ archived ".padEnd(70, "─"))}`)
    for (const e of archived) lines.push(...renderRow(e))
  }

  // Footer summary
  const filterParts: string[] = []
  filterParts.push(`cwd=${opts.filterCwd ?? "*"}`)
  filterParts.push(`branch=${opts.filterBranch ?? "*"}`)
  filterParts.push(`archived=${opts.showArchived === true ? "shown" : "hidden"}`)
  const sortLabel = `sort=${opts.sortBy ?? "recent"}`
  const showLabel = opts.lastN !== undefined ? `show: top ${opts.lastN}` : "show: all"
  lines.push("")
  lines.push(`  ${dim(`filter: ${filterParts.join(", ")}    ${sortLabel}    ${showLabel}`)}`)
  lines.push(dim("─".repeat(73)))
  return `${lines.join("\n")}\n`
}

/**
 * Public renderer. Pure string → string transform. The caller (the
 * `cmdLs` dispatcher in `index.ts`) chooses the format up front, applies
 * the filter pipeline via `applyListPipeline`, and writes the returned
 * string to its `out` port.
 */
export const renderSessionList = (
  entries: readonly SessionListEntry[],
  opts: SessionListOptions,
): string => {
  const fmt = opts.format ?? "rich"
  if (fmt === "plain") return renderPlain(entries)
  return renderRich(entries, opts)
}

// ────────────────────────────────────────────────────────────────────
// Convenience: build entries from raw SessionMeta[]
// ────────────────────────────────────────────────────────────────────

export interface BuildEntriesOptions {
  /** Inject `Date.now()` analogue so tests can pin ages deterministically. */
  now?: number
  /** When `true`, run `estimateTokens` per id (one stat() each). The
   *  dispatcher passes `true` for rich format only — plain format
   *  doesn't display a token column. */
  withTokenEstimates?: boolean
}

/** Wrap a `SessionMeta[]` (the shape `listSessions()` returns) into the
 *  renderable `SessionListEntry[]` shape. Adds `ageSeconds`, mirrors
 *  `archived`, and optionally estimates tokens by stat-ing the on-disk
 *  envelope/snapshot. Turn count is read from the snapshot ONLY when
 *  the caller has already loaded it — we don't open every JSON here.
 *  Pass `turnsById` to inject pre-computed counts. */
export const buildSessionListEntries = async (
  metas: readonly SessionMeta[],
  options: BuildEntriesOptions & { turnsById?: ReadonlyMap<string, number> } = {},
): Promise<SessionListEntry[]> => {
  const now = options.now ?? Date.now()
  const out: SessionListEntry[] = []
  for (const m of metas) {
    const entry: SessionListEntry = {
      meta: m,
      archived: m.archived,
      ageSeconds: Math.max(0, Math.floor((now - m.lastTouched) / 1000)),
    }
    const t = options.turnsById?.get(m.id)
    if (typeof t === "number") entry.turns = t
    if (options.withTokenEstimates === true) {
      const est = await estimateTokens(m.id)
      if (typeof est === "number") entry.totalTokens = est
    }
    out.push(entry)
  }
  return out
}
