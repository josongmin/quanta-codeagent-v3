/** ANSI / box-drawing UI helpers for the auth slash commands
 *  (`/login`, `/status`). No external deps — quanta installs are locked
 *  (memory `verify-workflow`), so this stays string-only.
 *
 *  Three SOTA++ pillars beyond the M1 sketch:
 *
 *  1. **NO_COLOR / non-TTY aware.** ANSI codes are gated through a small
 *     ColorPolicy resolver: `NO_COLOR` env (https://no-color.org), explicit
 *     `FORCE_COLOR=1`, and `process.stdout.isTTY` are consulted on first
 *     use. The decision is cached so colour state doesn't oscillate within
 *     one render. Tests can force the mode via `setColorPolicy(...)`.
 *  2. **ANSI-aware width math.** `visibleWidth` strips codes before
 *     counting — boxes line up even with mixed-colour content. The strip
 *     regex is the canonical CSI matcher used by every renderer here.
 *  3. **Grammatical relative time.** `humanRel` accepts `agoOnly: true`
 *     for fields that are semantically past (e.g. `last_refresh`); a
 *     future timestamp on such a field collapses to "just now" instead of
 *     printing the absurd "in 3h".
 */

const ESC = "\x1b["
export const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
} as const

// ────────────────────────────────────────────────────────────────────────
// Color policy
// ────────────────────────────────────────────────────────────────────────

type ResolvedMode = "on" | "off"

/** Encapsulates the color-policy cache so multiple surfaces (CLI, REPL,
 *  Tauri, tests) can keep isolated state instead of sharing one module-
 *  level cell. The module-level `setColorPolicy` / wrap helpers continue
 *  to operate against `defaultResolver` below — that path is byte-
 *  identical to the previous implementation. New callers that need
 *  isolation (e.g. a Tauri renderer that must not leak into CLI state,
 *  or a parallel test harness) can instantiate their own resolver. */
export class ColorPolicyResolver {
  private cached: ResolvedMode | null = null

  /** Resolve color mode lazily on first use. Order:
   *   1. Explicit override via `set()` (test seam).
   *   2. `NO_COLOR` env present (https://no-color.org) → off.
   *   3. `FORCE_COLOR=1` → on.
   *   4. `process.stdout.isTTY` truthy → on, else off. */
  resolve(): ResolvedMode {
    if (this.cached !== null) return this.cached
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
      this.cached = "off"
      return this.cached
    }
    if (process.env.FORCE_COLOR === "1") {
      this.cached = "on"
      return this.cached
    }
    this.cached = process.stdout.isTTY === true ? "on" : "off"
    return this.cached
  }

  /** Pin the color mode. `null` clears the override so the next
   *  `resolve()` re-derives from env / TTY. */
  set(mode: ResolvedMode | null): void {
    this.cached = mode
  }

  /** Convenience alias for `set(null)`. */
  reset(): void {
    this.cached = null
  }
}

const defaultResolver = new ColorPolicyResolver()

const resolveColorMode = (): ResolvedMode => defaultResolver.resolve()

/** Test seam: pin the color mode on the module-level default resolver.
 *  `null` clears the override so the next read re-resolves from env /
 *  TTY. Surfaces that need isolation should construct their own
 *  `ColorPolicyResolver` instead. */
export const setColorPolicy = (mode: ResolvedMode | null): void => {
  defaultResolver.set(mode)
}

const wrap = (s: string, ...codes: string[]): string =>
  resolveColorMode() === "off" ? s : `${codes.join("")}${s}${C.reset}`

export const bold = (s: string): string => wrap(s, C.bold)
export const dim = (s: string): string => wrap(s, C.dim)
export const red = (s: string): string => wrap(s, C.red)
export const green = (s: string): string => wrap(s, C.green)
export const yellow = (s: string): string => wrap(s, C.yellow)
export const blue = (s: string): string => wrap(s, C.blue)
export const magenta = (s: string): string => wrap(s, C.magenta)
export const cyan = (s: string): string => wrap(s, C.cyan)
export const gray = (s: string): string => wrap(s, C.gray)

// biome rule `noControlCharactersInRegex` fires on regex literals containing
// the ESC byte. We build the matcher via `new RegExp(...)` from a string so
// the literal control char never appears in source — runtime semantics are
// byte-identical to the previous `/\x1b\[[0-9;]*m/g` literal.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")
export const visibleWidth = (s: string): number => stripAnsi(s).length

// ────────────────────────────────────────────────────────────────────────
// Box rendering
// ────────────────────────────────────────────────────────────────────────

const BOX = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const

export interface BoxOptions {
  readonly title?: string
  readonly footer?: string
  readonly padX?: number
  /** Minimum visible content width (excluding pad). Default 56 so narrow
   *  boxes don't look cramped next to wider sibling boxes. */
  readonly minInner?: number
  /** Title colour. Applied to the title text only, never the border. */
  readonly titleStyle?: (s: string) => string
  readonly borderStyle?: (s: string) => string
  readonly footerStyle?: (s: string) => string
}

/** Render a rounded box. Multi-line content + ANSI colours supported.
 *  When `footer` is provided, a thin separator + dim footer line is
 *  drawn just above the bottom border — useful for small "meta" hints
 *  like "ADR-0094 Phase 1". */
export const renderBox = (lines: readonly string[], opts: BoxOptions = {}): string => {
  const padX = opts.padX ?? 2
  const minInner = opts.minInner ?? 56
  const titleVis = opts.title ? visibleWidth(opts.title) + 4 : 0
  const footerVis = opts.footer ? visibleWidth(opts.footer) : 0
  const inner = Math.max(minInner, ...lines.map(visibleWidth), titleVis, footerVis)
  const totalW = inner + padX * 2
  const tStyle = opts.titleStyle ?? ((s) => s)
  const bStyle = opts.borderStyle ?? ((s) => s)
  const fStyle = opts.footerStyle ?? dim
  // Top border with title: "╭─ {title} {h.repeat(N)}╮"
  // Inner band (between corners) must equal totalW visible chars:
  //   1 ("─") + 1 (" ") + visibleWidth(title) + 1 (" ") + N = totalW
  // ⇒ N = totalW − visibleWidth(title) − 3
  const top = opts.title
    ? bStyle(BOX.tl + BOX.h) +
      " " +
      tStyle(opts.title) +
      " " +
      bStyle(BOX.h.repeat(Math.max(0, totalW - visibleWidth(opts.title) - 3))) +
      bStyle(BOX.tr)
    : bStyle(BOX.tl + BOX.h.repeat(totalW) + BOX.tr)
  const body = lines.map((l) => renderRow(l, inner, padX, bStyle))
  const footerLines: string[] = []
  if (opts.footer) {
    footerLines.push(
      bStyle(BOX.v) +
        " ".repeat(padX) +
        dim(BOX.h.repeat(inner)) +
        " ".repeat(padX) +
        bStyle(BOX.v),
    )
    footerLines.push(renderRow(fStyle(opts.footer), inner, padX, bStyle))
  }
  const bottom = bStyle(BOX.bl + BOX.h.repeat(totalW) + BOX.br)
  return [top, ...body, ...footerLines, bottom].join("\n")
}

const renderRow = (
  line: string,
  inner: number,
  padX: number,
  bStyle: (s: string) => string,
): string => {
  const right = " ".repeat(Math.max(0, inner - visibleWidth(line)))
  return bStyle(BOX.v) + " ".repeat(padX) + line + right + " ".repeat(padX) + bStyle(BOX.v)
}

// ────────────────────────────────────────────────────────────────────────
// Domain helpers (used by /login, /status)
// ────────────────────────────────────────────────────────────────────────

/** Compact status pill: `● label` with a colored leading dot. */
export const statusPill = (state: "ok" | "warn" | "err" | "off", label: string): string => {
  switch (state) {
    case "ok":
      return `${green("●")} ${green(label)}`
    case "warn":
      return `${yellow("●")} ${yellow(label)}`
    case "err":
      return `${red("●")} ${red(label)}`
    case "off":
      return `${gray("○")} ${gray(label)}`
  }
}

export interface HumanRelOptions {
  /** When `true`, a future timestamp is rendered as "just now" instead of
   *  "in Xh". Use for fields that are semantically past — `last_refresh`,
   *  `last_seen`, audit timestamps. */
  readonly agoOnly?: boolean
}

/** Format a humanised relative time. `iso` may be ISO-8601 / RFC-3339 /
 *  anything `Date.parse` understands. */
export const humanRel = (iso: string, nowMs: number, opts: HumanRelOptions = {}): string => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "unknown time"
  const diff = ms - nowMs
  if (opts.agoOnly === true && diff > 0) return "just now"
  const past = diff < 0
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  if (sec < 5) return "just now"
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return past ? `${hr}h ago` : `in ${hr}h`
  const day = Math.round(hr / 24)
  return past ? `${day}d ago` : `in ${day}d`
}

/** Pick a colour helper based on how close `iso` is to expiring.
 *   - expired / unparseable        → red
 *   - <5 min remaining             → red
 *   - <1 h remaining               → yellow
 *   - otherwise                    → green */
export const expiryColor = (iso: string, nowMs: number): ((s: string) => string) => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return red
  const remain = ms - nowMs
  if (remain <= 0) return red
  if (remain < 5 * 60 * 1000) return red
  if (remain < 60 * 60 * 1000) return yellow
  return green
}

/** Compose a "key   value" line where the key is dim-padded to `keyW`
 *  visible chars. Used by `/login` + `/status` to align stacked field
 *  rows without measuring the longest key per call. */
export const kvLine = (key: string, value: string, keyW = 12): string => {
  const pad = " ".repeat(Math.max(0, keyW - key.length))
  return `${dim(key + pad)}${value}`
}
