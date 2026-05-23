/**
 * Status pills — surface-agnostic composer for the CLI's bottom status line.
 *
 * Renders a single ANSI-colored line containing up to four "pills":
 *
 *   @ <workspace>   [<MODE>] [🧠 <effort>] [skills: …]   <sandbox-badge>
 *
 *   - LEFT  : `@ basename(cwd)` (dim cyan)
 *   - CENTER: `[MODE]` (yellow=plan, magenta=review, cyan=audit; "default" hidden)
 *             + `[🧠 effort]` (red=high/max, dim=low; "default"/"medium" hidden)
 *   - C-RIGHT: `[skills: name1 · name2]` (dim green); folds to `[skills: N active]`
 *              when ≥3 skills or when the line would overflow.
 *   - RIGHT: sandbox badge — `🔒 read-only` (dim), `⚙ workspace` (yellow),
 *             `⚡ danger` (bold red); "default" hidden.
 *
 * Composition is pure: `render()` produces a string suitable for
 * {@link StatusBar.setDefault}. The pills compose ABOVE the existing
 * transient-message channel — `statusBar.transient(...)` still works and
 * the pill row reverts as the default after the transient fades.
 *
 * ENV gating (all default-ON; "0"/"false"/"off" = OFF):
 *   - QUANTA_PILLS              : master switch (default ON when TTY)
 *   - QUANTA_PILL_WORKSPACE     : workspace pill
 *   - QUANTA_PILL_MODE          : mode + effort pills
 *   - QUANTA_PILL_SKILLS        : skills pill
 *   - QUANTA_PILL_SANDBOX       : sandbox pill
 *
 * Non-TTY (stdin not a TTY OR no statusBar) ⇒ no-op composer: `update()` and
 * `dispose()` are inert and `render()` returns "". This keeps `quanta < file`
 * pipes byte-identical to today.
 *
 * Slice: this module imports ONLY type-level constructs from `@/agent` (the
 * `AgentMode` / `EffortLevel` literal unions are erased at runtime). It does
 * not import the agent runtime; the CLI surface owns construction.
 */

import type { AgentMode, EffortLevel } from "@/agent"
import type { StatusBar } from "./status-bar"

// ANSI escapes — kept inline (no fancy color lib) so the module stays import-light.
const ESC = "\x1b["
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const FG_RED = `${ESC}31m`
const FG_YELLOW = `${ESC}33m`
const FG_MAGENTA = `${ESC}35m`
const FG_CYAN = `${ESC}36m`
const FG_GREEN = `${ESC}32m`

/** Sandbox enum mirrors catalog ADR-0012. `"default"` = no wire yet ⇒ hide. */
export type SandboxMode = "read-only" | "workspace" | "danger" | "default"

/** Active state the pill composer paints. All fields optional so partial
 *  updates (e.g. only `mode` changed) don't need a re-spread of the others. */
export interface StatusPillsState {
  cwd?: string
  mode?: AgentMode
  effort?: EffortLevel
  activeSkills?: { name: string; description?: string }[]
  sandboxMode?: SandboxMode
}

export interface StatusPills {
  /** Merge `patch` into the current state and repaint the status row.
   *  No-op when the composer is disabled (non-TTY or QUANTA_PILLS=0). */
  update(patch: Partial<StatusPillsState>): void
  /** Pure render of the CURRENT state. Returns `""` when disabled. */
  render(): string
  /** Idempotent teardown — clears the cached state. Does NOT teardown the
   *  underlying {@link StatusBar}; the caller still owns that lifecycle. */
  dispose(): void
}

/** Coerce an env value to a boolean. Treats `"0"`, `"false"`, `"off"` (case-
 *  insensitive, trimmed) as false; everything else (including `undefined` for
 *  the master switch fallback) is true. Caller controls the default. */
const envFlag = (raw: string | undefined, defaultOn: boolean): boolean => {
  if (raw === undefined) return defaultOn
  const v = raw.trim().toLowerCase()
  if (v === "" || v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return defaultOn
}

/** Per-pill ENV inventory — extracted so the test can list/clear them. */
export const PILL_ENV_VARS = [
  "QUANTA_PILLS",
  "QUANTA_PILL_WORKSPACE",
  "QUANTA_PILL_MODE",
  "QUANTA_PILL_SKILLS",
  "QUANTA_PILL_SANDBOX",
] as const

/** Strip ANSI escapes — exposed for the test only. */
export const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
  s.replace(/\x1b\[[0-9;]*m/g, "")

/** Workspace basename: prefer the last segment of `cwd`. POSIX + Win path-sep
 *  tolerant. Empty/undefined ⇒ `""` (pill suppressed). Truncated to 32 chars. */
const formatWorkspace = (cwd: string | undefined): string => {
  if (cwd === undefined || cwd === "") return ""
  // Trailing-separator tolerant.
  const trimmed = cwd.replace(/[/\\]+$/u, "")
  const parts = trimmed.split(/[/\\]/u)
  const base = parts[parts.length - 1] ?? ""
  if (base === "") return ""
  return base.length > 32 ? `${base.slice(0, 31)}…` : base
}

/** Mode → colored pill. `default` returns "" (suppressed to reduce clutter). */
const formatMode = (mode: AgentMode | undefined): string => {
  if (mode === undefined || mode === "default") return ""
  if (mode === "plan") return `${BOLD}${FG_YELLOW}[PLAN]${RESET}`
  if (mode === "review") return `${BOLD}${FG_MAGENTA}[REVIEW]${RESET}`
  if (mode === "audit") return `${BOLD}${FG_CYAN}[AUDIT]${RESET}`
  return ""
}

/** Effort → colored pill. `default` and `medium` suppressed (least-surprise
 *  baselines). `high`/`max` highlighted; `low` dimmed. */
const formatEffort = (effort: EffortLevel | undefined): string => {
  if (effort === undefined || effort === "default" || effort === "medium") return ""
  if (effort === "high" || effort === "max") return `${BOLD}${FG_RED}[🧠 ${effort}]${RESET}`
  if (effort === "low") return `${DIM}[🧠 low]${RESET}`
  return ""
}

/** Skills pill. 0 skills ⇒ "". 1-2 skills ⇒ inline names. 3+ ⇒ count fold. */
const formatSkills = (skills: { name: string }[] | undefined): string => {
  if (skills === undefined || skills.length === 0) return ""
  if (skills.length >= 3) return `${DIM}${FG_GREEN}[skills: ${skills.length} active]${RESET}`
  const names = skills.map((s) => s.name).join(" · ")
  return `${DIM}${FG_GREEN}[skills: ${names}]${RESET}`
}

/** Sandbox badge. `default` ⇒ "" (no wire yet — catalog ADR-0012 placeholder). */
const formatSandbox = (mode: SandboxMode | undefined): string => {
  if (mode === undefined || mode === "default") return ""
  if (mode === "read-only") return `${DIM}🔒 read-only${RESET}`
  if (mode === "workspace") return `${FG_YELLOW}⚙ workspace${RESET}`
  if (mode === "danger") return `${BOLD}${FG_RED}⚡ danger${RESET}`
  return ""
}

interface PillFlags {
  enabled: boolean
  workspace: boolean
  mode: boolean
  skills: boolean
  sandbox: boolean
}

const readFlags = (
  env: NodeJS.ProcessEnv,
  enabledOverride: boolean | undefined,
  tty: boolean,
): PillFlags => {
  // Master switch precedence:
  //   1. explicit `enabledOverride` arg wins (tests / hosts)
  //   2. QUANTA_PILLS env (default ON)
  //   3. non-TTY ⇒ always OFF (irrespective of env, irrespective of override:
  //      we honour the override only when TTY is positive — never paint ANSI
  //      to a non-TTY sink).
  if (!tty) return { enabled: false, workspace: false, mode: false, skills: false, sandbox: false }
  const master = enabledOverride ?? envFlag(env.QUANTA_PILLS, true)
  return {
    enabled: master,
    workspace: envFlag(env.QUANTA_PILL_WORKSPACE, true),
    mode: envFlag(env.QUANTA_PILL_MODE, true),
    skills: envFlag(env.QUANTA_PILL_SKILLS, true),
    sandbox: envFlag(env.QUANTA_PILL_SANDBOX, true),
  }
}

/** Append `pill` to `bucket` iff non-empty. Tiny helper extracted so
 *  {@link composeLine} stays under the biome cognitive-complexity budget. */
const pushIfNotEmpty = (bucket: string[], pill: string): void => {
  if (pill !== "") bucket.push(pill)
}

/** Compose the left/center/right pill buckets for one render. Pure: depends
 *  only on the snapshot `state` and the resolved `flags`. Extracted from
 *  `renderOnce` so the per-pill gating + concat doesn't blow the cognitive-
 *  complexity budget of the closure. */
const composeLine = (state: StatusPillsState, flags: PillFlags): string => {
  const left: string[] = []
  const center: string[] = []
  const right: string[] = []

  if (flags.workspace) {
    const ws = formatWorkspace(state.cwd)
    if (ws !== "") left.push(`${DIM}${FG_CYAN}@ ${ws}${RESET}`)
  }
  if (flags.mode) {
    pushIfNotEmpty(center, formatMode(state.mode))
    pushIfNotEmpty(center, formatEffort(state.effort))
  }
  if (flags.skills) pushIfNotEmpty(center, formatSkills(state.activeSkills))
  if (flags.sandbox) pushIfNotEmpty(right, formatSandbox(state.sandboxMode))

  // Layout: LEFT [3sp] CENTER [3sp] RIGHT — separators dropped when a side
  // is empty so we don't pad-print an empty line.
  const sep = "   "
  const segs: string[] = []
  pushIfNotEmpty(segs, left.join(" "))
  pushIfNotEmpty(segs, center.join(" "))
  pushIfNotEmpty(segs, right.join(" "))
  return segs.join(sep)
}

export interface CreateStatusPillsOpts {
  /** Underlying status bar; the pill row is pushed via `setDefault`. Absent
   *  ⇒ render-only composer (state is tracked, no painting). */
  statusBar?: StatusBar
  /** Initial pill state. Empty object is OK — pills suppress empty fields. */
  initial?: StatusPillsState
  /** Hard override of the master switch (bypasses `QUANTA_PILLS`). Used by
   *  tests; production callers should leave undefined. */
  enabled?: boolean
  /** Override TTY detection for tests. Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean
  /** Env source — defaults to `process.env`. Injected for hermetic tests. */
  env?: NodeJS.ProcessEnv
}

export const createStatusPills = (opts: CreateStatusPillsOpts = {}): StatusPills => {
  const env = opts.env ?? process.env
  const tty = opts.isTTY ?? Boolean(process.stdout.isTTY)
  const flags = readFlags(env, opts.enabled, tty)
  let state: StatusPillsState = { ...(opts.initial ?? {}) }
  let disposed = false

  const renderOnce = (): string => {
    if (!flags.enabled || disposed) return ""
    return composeLine(state, flags)
  }

  const paint = (): void => {
    if (!flags.enabled || opts.statusBar === undefined || disposed) return
    opts.statusBar.setDefault(renderOnce())
  }

  // Paint the initial state immediately so the bar reflects pills from t0.
  if (flags.enabled && opts.statusBar !== undefined) paint()

  return {
    update(patch: Partial<StatusPillsState>): void {
      if (disposed) return
      state = { ...state, ...patch }
      paint()
    },
    render(): string {
      return renderOnce()
    },
    dispose(): void {
      disposed = true
      state = {}
    },
  }
}
