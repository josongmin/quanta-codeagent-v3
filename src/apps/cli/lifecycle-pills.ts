/**
 * Lifecycle status pills — subagent / follow-up queue / MCP server health.
 *
 * A single-line, viewport-safe status row printed to stderr at the end of each
 * turn (or at session start when MCP is wired). Decoupled from any data
 * source: the caller (typically `repl.ts`) drives updates via `update(patch)`
 * and decides WHEN to call `render()`.
 *
 *   [tasks: 3/5 running] [follow-up: 1 queued (paused: tool_result)] [mcp: ✓ fs, ✗ playwright]
 *
 * Conditional render matrix (a pill is omitted when its precondition fails):
 *   - subagent: `running > 0 || total > 0`
 *   - follow-up: `queued > 0`
 *   - mcp: `servers.length > 0` (any registered)
 *
 * Default-ON when stderr is a TTY and no `QUANTA_LIFECYCLE_PILLS=0` knob.
 * Per-pill OFF knobs: `QUANTA_PILL_TASKS=0`, `QUANTA_PILL_FOLLOWUP=0`,
 * `QUANTA_PILL_MCP=0`. ENV is read at construction time so tests can drive
 * via the `enabled` opt directly.
 *
 * Slice-isolation: imports nothing from `@/agent`, `@/mcp`, `@/subagent` —
 * the consumer translates registry / queue / client state into the
 * {@link LifecycleState} shape and calls `update()`.
 */

/** Subagent task counts surfaced on the pill. `running` is the current
 *  `TaskRegistry.pendingIds().length` snapshot; `total` is the cumulative
 *  count of spawned tasks this session (running + settled). */
export interface SubagentPillState {
  running: number
  total: number
  /** Optional agent nicknames (Feynman, Noether — Codex 39-pool). Display is
   *  capped to 3 to keep the pill within the viewport. */
  names?: string[]
}

/** Follow-up queue snapshot for the pill. `queued` is the total across all
 *  threads (`FollowUpQueue.size()`); `pausedReason` is the most recent
 *  non-null `PausedReason` returned by `cfg.pausedReason(threadId)`. */
export interface FollowUpPillState {
  queued: number
  pausedReason?: string
}

/** MCP server health row. Status is derived from the surface's MCP wiring:
 *  a client returned by `loadMcpTools` is `"connected"`; a configured server
 *  that did NOT yield a live client is `"down"`. `"degraded"` is reserved for
 *  future health-probe wiring. */
export interface McpPillServer {
  name: string
  status: "connected" | "degraded" | "down"
  toolCount?: number
}

export interface McpPillState {
  servers: McpPillServer[]
}

/** Composite state. Each field is optional — `update(patch)` merges per-key
 *  so a caller can refresh ONE pill without touching the others. */
export interface LifecycleState {
  subagent?: SubagentPillState
  followUp?: FollowUpPillState
  mcp?: McpPillState
}

export interface LifecyclePills {
  /** Merge a partial patch into the current state. Fields set to `undefined`
   *  in the patch are ignored (use `clear*` semantics by passing an explicit
   *  empty shape, e.g. `{ subagent: { running: 0, total: 0 } }`, which then
   *  falls below the render threshold). */
  update(patch: Partial<LifecycleState>): void
  /** Build the current pill line. Returns `""` when disabled OR every pill is
   *  below its threshold (caller decides whether to write an empty line). */
  render(): string
  /** Render to `out` (default `process.stderr.write`), appending a trailing
   *  `"\n"` so the next prompt sits on a fresh row. No-op when render is
   *  empty so a quiet turn doesn't leave a blank line behind. */
  flush(): void
  /** Idempotent teardown — releases any held resources (none today, but the
   *  contract is forward-compatible with timer-driven refresh modes). */
  dispose(): void
}

export interface LifecyclePillsOpts {
  /** Force-enable or force-disable. `undefined` ⇒ env+TTY auto-detect via
   *  {@link isLifecyclePillsEnabled} (caller should pre-compute and pass). */
  enabled?: boolean
  /** Writer for `flush()`. Default `process.stderr.write` bound. Pure DI so
   *  tests capture output without a real terminal. */
  out?: (s: string) => void
  /** Per-pill OFF flags — when `true`, the corresponding pill is suppressed
   *  even if state would otherwise render it. */
  hideTasks?: boolean
  hideFollowUp?: boolean
  hideMcp?: boolean
  /** Max viewport columns; defaults to `process.stderr.columns` or 80. When
   *  the rendered line exceeds this, MCP details fold to a count summary
   *  (`[mcp: 3/5 connected]`). */
  viewportCols?: number
}

const DEFAULT_VIEWPORT_COLS = 80
const MAX_NAMES_DISPLAYED = 3
/** Threshold above which MCP details fold to a count summary. The fold
 *  triggers when the rendered line would exceed `viewportCols`. */
const MCP_FOLD_SERVER_COUNT = 4

/**
 * Render a single pill segment with bracket delimiters. Pure helper so the
 * tests can target the format without instantiating the factory. Empty input
 * returns `""` so the caller can `.filter(Boolean)` to drop blank pills.
 */
const renderSubagentPill = (s: SubagentPillState | undefined): string => {
  if (s === undefined) return ""
  if (s.running <= 0 && s.total <= 0) return ""
  const total = Math.max(s.total, s.running)
  let line = `[tasks: ${s.running}/${total} running`
  if (s.names !== undefined && s.names.length > 0) {
    const head = s.names.slice(0, MAX_NAMES_DISPLAYED).join(", ")
    const more =
      s.names.length > MAX_NAMES_DISPLAYED ? ` +${s.names.length - MAX_NAMES_DISPLAYED}` : ""
    line += `: ${head}${more}`
  }
  line += "]"
  return line
}

const renderFollowUpPill = (s: FollowUpPillState | undefined): string => {
  if (s === undefined) return ""
  if (s.queued <= 0) return ""
  let line = `[follow-up: ${s.queued} queued`
  if (s.pausedReason !== undefined && s.pausedReason.length > 0) {
    line += ` (paused: ${s.pausedReason})`
  }
  line += "]"
  return line
}

const glyphFor = (status: McpPillServer["status"]): string => {
  if (status === "connected") return "✓"
  if (status === "down") return "✗"
  return "~" // degraded
}

const renderMcpPill = (s: McpPillState | undefined, viewportCols: number): string => {
  if (s === undefined) return ""
  const servers = s.servers
  if (servers.length === 0) return ""
  const detail = servers.map((sv) => `${glyphFor(sv.status)} ${sv.name}`).join(", ")
  const detailed = `[mcp: ${detail}]`
  // Fold to count summary if the line is too long OR there are many servers.
  if (servers.length <= MCP_FOLD_SERVER_COUNT && detailed.length <= viewportCols) {
    return detailed
  }
  const connected = servers.filter((sv) => sv.status === "connected").length
  return `[mcp: ${connected}/${servers.length} connected]`
}

/**
 * Read the env + TTY to decide whether pills should render. Pure function —
 * the caller passes the env and TTY-ness explicitly so unit tests don't have
 * to mutate globals. Default-ON when TTY; explicit `"0"`/`"false"`/`"off"`/
 * `"no"` disables. Non-TTY ⇒ always OFF (eval/bench surfaces stay
 * byte-identical).
 */
export const isLifecyclePillsEnabled = (
  env: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): boolean => {
  if (isTTY !== true) return false
  const knob = env.QUANTA_LIFECYCLE_PILLS
  if (knob === undefined) return true
  const norm = knob.trim().toLowerCase()
  return norm !== "0" && norm !== "false" && norm !== "off" && norm !== "no"
}

/**
 * Build per-pill suppression flags from env. Each `QUANTA_PILL_*` knob takes
 * the same `"0"`/`"false"`/`"off"`/`"no"` family (any other value ⇒ pill ON).
 */
export const readPillEnvFlags = (
  env: NodeJS.ProcessEnv,
): { hideTasks: boolean; hideFollowUp: boolean; hideMcp: boolean } => {
  const isOff = (v: string | undefined): boolean => {
    if (v === undefined) return false
    const n = v.trim().toLowerCase()
    return n === "0" || n === "false" || n === "off" || n === "no"
  }
  return {
    hideTasks: isOff(env.QUANTA_PILL_TASKS),
    hideFollowUp: isOff(env.QUANTA_PILL_FOLLOWUP),
    hideMcp: isOff(env.QUANTA_PILL_MCP),
  }
}

/**
 * Construct a {@link LifecyclePills} instance. State starts empty; the caller
 * pushes patches via `update()` and triggers a paint via `flush()` (or builds
 * the string via `render()` for embedding in another row). When `enabled` is
 * `false` every method becomes a no-op render and `flush()` skips the write —
 * the API is still callable so downstream code can stay branch-free.
 */
export const createLifecyclePills = (opts: LifecyclePillsOpts = {}): LifecyclePills => {
  const enabled = opts.enabled !== false
  const out =
    opts.out ??
    ((s: string): void => {
      process.stderr.write(s)
    })
  const hideTasks = opts.hideTasks === true
  const hideFollowUp = opts.hideFollowUp === true
  const hideMcp = opts.hideMcp === true
  const viewportCols = opts.viewportCols ?? process.stderr.columns ?? DEFAULT_VIEWPORT_COLS
  let state: LifecycleState = {}
  let disposed = false

  const update = (patch: Partial<LifecycleState>): void => {
    if (disposed) return
    // Per-key shallow merge: an explicit `undefined` in the patch is a no-op,
    // a present field replaces the prior value (objects are NOT deep-merged
    // — callers compute the full pill state per-update).
    const next: LifecycleState = { ...state }
    if (patch.subagent !== undefined) next.subagent = patch.subagent
    if (patch.followUp !== undefined) next.followUp = patch.followUp
    if (patch.mcp !== undefined) next.mcp = patch.mcp
    state = next
  }

  /** Collect the non-empty pill segments in canonical order. Empty arrays
   *  short-circuit `render()` to the empty string — the caller's flush path
   *  also skips an empty result so a quiet turn doesn't write a blank line. */
  const collectParts = (): string[] => {
    const parts: string[] = []
    const tasks = hideTasks ? "" : renderSubagentPill(state.subagent)
    if (tasks.length > 0) parts.push(tasks)
    const fu = hideFollowUp ? "" : renderFollowUpPill(state.followUp)
    if (fu.length > 0) parts.push(fu)
    const mcp = hideMcp ? "" : renderMcpPill(state.mcp, viewportCols)
    if (mcp.length > 0) parts.push(mcp)
    return parts
  }

  const render = (): string => {
    if (!enabled || disposed) return ""
    const parts = collectParts()
    if (parts.length === 0) return ""
    const line = parts.join(" ")
    // Final viewport guard: ANSI-free hard truncate with ellipsis. Pills are
    // ASCII-only today so byte length == column count.
    if (line.length <= viewportCols) return line
    return `${line.slice(0, Math.max(0, viewportCols - 1))}…`
  }

  const flush = (): void => {
    if (!enabled || disposed) return
    const line = render()
    if (line.length === 0) return
    out(`${line}\n`)
  }

  const dispose = (): void => {
    disposed = true
  }

  return { update, render, flush, dispose }
}
