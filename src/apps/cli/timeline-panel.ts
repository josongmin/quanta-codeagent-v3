/** Split-screen live AgentEvent timeline panel above the status bar.
 *
 *  The CLI already pins the very last terminal row as a vim-style status bar
 *  via DECSTBM (`./status-bar.ts`): the scroll region is set to `[1, rows-1]`
 *  so stream output never overwrites the bar. This panel takes the next step
 *  and reserves an additional N rows ABOVE the status bar for a live timeline
 *  of `AgentEvent` emits (think: a debug ticker showing tool calls, recovery,
 *  usage, etc. in arrival order, ring-buffered to the panel height).
 *
 *  Layout when enabled (height = N, terminal `rows` total):
 *    rows 1 .. rows-N-1   ← scroll region (model stream, slash echoes, etc.)
 *    rows rows-N .. rows-1 ← timeline panel (N rows, ring-buffered)
 *    row  rows             ← status bar (unchanged, painted by status-bar.ts)
 *
 *  Design constraints (pin):
 *   - **Default-OFF byte-identical.** `height === 0` ⇒ the returned handle is a
 *     pure no-op: `emit` drops, `onResize` is a no-op, `teardown` is a no-op.
 *     The terminal sees ZERO DECSTBM rewrites from this module, so the surface
 *     remains visually indistinguishable from the pre-timeline build.
 *   - **Status bar invariant preserved.** When enabled we still PIN the bottom
 *     row (row = `rows`) OUTSIDE the scroll region — we only NARROW the upper
 *     bound from `rows-1` to `rows-N-1`. The status bar's own `paintRow`
 *     continues to land on row `rows` exactly as before. The ADR-0239
 *     `cols+1` overflow invariant is unaffected (we never touch the bar row).
 *   - **Pure DI** for tests. `geometry`, `write`, `now`, `color` are injectable.
 *   - **Cursor preservation.** Every panel repaint is wrapped in DECSC/DECRC
 *     (cursor save/restore) so an in-flight stream paint that lands in the
 *     same write tick is not jumped to the panel row.
 *   - **Slice isolation.** Only depends on `@/stream` for the `AgentEvent`
 *     shape — no `@/agent`, no `@/llm`, no `./status-bar` import (the panel
 *     and the bar are siblings; coupling them at the type level would block
 *     the byte-identical default-OFF goal).
 */

import type { AgentEvent } from "@/stream"

// --- ANSI control sequences ---------------------------------------------

const ESC = "\x1b["
const SAVE_CURSOR = `${ESC}s`
const RESTORE_CURSOR = `${ESC}u`
const ERASE_LINE = `${ESC}2K`
const FG_DIM = `${ESC}2m`
const FG_RESET = `${ESC}22;39m`

/** DECSTBM — set the scroll region to lines [top, bottom] (1-indexed,
 *  inclusive). The last row (row = `rows`) is reserved for the status bar
 *  and stays OUTSIDE the scroll region. */
const decstbm = (top: number, bottom: number): string => `${ESC}${top};${bottom}r`

/** DECSTBM reset — restore the default scroll region (full screen). Used at
 *  teardown so a follow-on `installStatusBar.teardown` (which writes the same
 *  reset) is idempotent and the shell prompt that succeeds quanta exits onto
 *  a clean screen. */
const decstbmReset = `${ESC}r`

// --- Public surface -----------------------------------------------------

/** Options passed to {@link createTimelinePanel}. All fields are optional
 *  except `height`; the defaults read the platform globals at call time. */
export interface TimelineOptions {
  /** Number of timeline rows above the status bar. `0` ⇒ panel disabled
   *  (the handle is a pure no-op — no DECSTBM write, no buffer, no paint).
   *  Capped at `min(rows - 5, MAX_PANEL_HEIGHT)` so the scroll region stays
   *  usable on small terminals. Negative / NaN / non-finite values clamp to
   *  `0` (treated as disabled). */
  readonly height: number
  /** Test seam for terminal geometry — default reads `process.stderr.{rows,
   *  columns}`. Returning `rows <= 4` forces a disabled panel (see
   *  {@link clampHeight}). */
  readonly geometry?: () => { rows: number; cols: number }
  /** Emit ANSI colour codes (`true`) or strip them (`false`). Default
   *  `process.stderr.isTTY === true`. */
  readonly color?: boolean
  /** Write sink — default `process.stderr.write` bound to stderr. */
  readonly write?: (chunk: string) => void
  /** Wall-clock seam (used for the per-row timestamp prefix). Default
   *  `Date.now`. */
  readonly now?: () => number
}

export interface TimelinePanel {
  /** Append an `AgentEvent` to the ring buffer + repaint the panel. A no-op
   *  when `height === 0` or the panel was never installed. Errors raised
   *  by the write sink are SWALLOWED (the timeline is a UX surface, never
   *  a control path — a broken render must not poison the recorder tee). */
  readonly emit: (event: AgentEvent) => void
  /** Resize handler — re-clamp `height` against the new geometry and
   *  re-emit the DECSTBM pin so the scroll region tracks the terminal.
   *  No-op when disabled. */
  readonly onResize: () => void
  /** Teardown — reset the scroll region back to default and erase the
   *  panel rows so any subsequent shell prompt (after quanta exits) lands
   *  on a clean screen. Idempotent — safe to call when disabled or after
   *  a prior teardown. */
  readonly teardown: () => void
}

/** Absolute cap on panel height regardless of terminal size. Above ~20 the
 *  panel starts to dominate the surface and the ring buffer ceases to feel
 *  like a "live ticker" — at that point a dedicated /history surface is the
 *  right tool. */
export const MAX_PANEL_HEIGHT = 20

/** Minimum number of scroll-region rows we MUST leave for stream output.
 *  Below this the surface becomes unusable (model paints would scroll the
 *  status bar). Empirically 4 rows is the floor — anything below clamps the
 *  panel to disabled. */
const MIN_SCROLL_ROWS = 4

/** Clamp a requested panel height against the current terminal geometry.
 *  Returns `0` for "disabled" (the timeline becomes a no-op) when:
 *   - `height` is not a finite positive integer
 *   - `rows <= MIN_SCROLL_ROWS + 1` (terminal too small to host even a 1-row
 *     panel without breaking the status bar invariant)
 *  Otherwise returns `min(requested, rows - MIN_SCROLL_ROWS - 1, MAX_PANEL_HEIGHT)`.
 *  `-1` accounts for the status bar row itself. */
export const clampHeight = (requested: number, rows: number): number => {
  if (!Number.isFinite(requested) || requested <= 0) return 0
  if (!Number.isFinite(rows) || rows <= MIN_SCROLL_ROWS + 1) return 0
  const maxFromGeometry = rows - MIN_SCROLL_ROWS - 1
  return Math.min(Math.floor(requested), maxFromGeometry, MAX_PANEL_HEIGHT)
}

// --- Event ➜ one-line formatter -----------------------------------------

/** Render a single timeline row for an `AgentEvent`. The format is short and
 *  stable (each row owns its own column budget): `HH:MM:SS  <kind>  <hint>`.
 *  Unknown / new event types fall through to a generic `<type>` row instead
 *  of throwing — the timeline must remain forward-compatible with future
 *  `AgentEvent` variants the runtime might emit. */
export const formatEventLine = (event: AgentEvent, ts: number): string => {
  const time = formatHms(ts)
  const body = renderBody(event)
  return `${time}  ${body}`
}

const renderBody = (event: AgentEvent): string => {
  switch (event.type) {
    case "session_start":
      return "session"
    case "turn_start":
      return `turn ${event.turn}`
    case "llm_request":
      return `llm_request ${event.model}`
    case "llm_continuation":
      return `llm_continuation ${event.mode} ${event.reason}`
    case "assistant_text":
      return `assistant_text ${event.delta.length}b`
    case "in_progress":
      return event.message !== undefined ? `in_progress ${event.message}` : "in_progress"
    case "tool_call":
      return `tool_call ${event.name}`
    case "tool_progress":
      return `tool_progress ${event.name} ${event.message}`
    case "tool_result":
      return `tool_result ${event.name} ${event.ok ? "ok" : "fail"}`
    case "recovery":
      return `recovery ${event.reason}`
    case "context_compacted":
      return `compacted ${event.tokens}t`
    case "error":
      return `error ${event.message}`
    case "usage":
      return `usage in=${event.inputTokens} out=${event.outputTokens}`
    case "response_queued":
      return `queued ${event.reason}`
    case "interrupted":
      return `interrupted ${event.source}`
    case "subagent_cancel":
      return `subagent_cancel ${event.subagentId} ${event.outcome}`
    case "plan_created":
      return `plan_created ${event.plan.name}`
    case "plan_updated":
      return `plan_updated v${event.version}`
    case "plan_snapshot":
      return `plan_snapshot ${event.plan.name}`
    case "plan_user_input_requested":
      return `plan_input_req ${event.promptId}`
    case "plan_user_input_resolved":
      return `plan_input_resolved ${event.decision}`
    case "mode_changed":
      return `mode ${event.from}→${event.to}`
    case "turn_diff_updated":
      return `turn_diff turn=${event.turn} files=${event.filesChanged}`
    case "done":
      return `done ${event.reason} turns=${event.turns}`
    default:
      // Forward-compat: an `AgentEvent` variant we don't render yet still
      // shows up as a generic row. `(event as { type: string }).type` is
      // safe — every variant in the closed union has a string `type`.
      return (event as { type: string }).type
  }
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

const formatHms = (ts: number): string => {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// --- Factory ------------------------------------------------------------

const NOOP_PANEL: TimelinePanel = {
  emit: () => undefined,
  onResize: () => undefined,
  teardown: () => undefined,
}

const defaultGeometry = (): { rows: number; cols: number } => {
  const r = process.stderr.rows
  const c = process.stderr.columns
  return {
    rows: typeof r === "number" && r > 0 ? r : 24,
    cols: typeof c === "number" && c > 0 ? c : 80,
  }
}

const defaultWrite = (chunk: string): void => {
  process.stderr.write(chunk)
}

/** Construct a timeline panel. See {@link TimelineOptions}. */
export const createTimelinePanel = (opts: TimelineOptions): TimelinePanel => {
  const geometry = opts.geometry ?? defaultGeometry
  const write = opts.write ?? defaultWrite
  const now = opts.now ?? Date.now
  const color = opts.color ?? process.stderr.isTTY === true

  const initial = geometry()
  let height = clampHeight(opts.height, initial.rows)
  if (height === 0) return NOOP_PANEL

  // Ring buffer sized to current height. Resize re-allocates.
  let buffer: AgentEvent[] = []
  let timestamps: number[] = []
  let installed = false

  const safeWrite = (chunk: string): void => {
    try {
      write(chunk)
    } catch {
      // Intentional: a broken sink (closed stderr, EPIPE) must not crash
      // the timeline path. The status bar's own writes follow the same
      // posture in status-bar.ts; we mirror it here.
    }
  }

  const pinScrollRegion = (rows: number): void => {
    // Scroll region runs from row 1 to (rows - height - 1). That leaves
    // `height` rows for the panel (rows-height .. rows-1) and one row
    // (rows) for the status bar — unchanged from the pre-timeline layout.
    const bottom = rows - height - 1
    safeWrite(decstbm(1, bottom))
    // Park the cursor inside the scroll region so the next stdout write
    // does not accidentally land on a panel row.
    safeWrite(`${ESC}${bottom};1H`)
  }

  const truncate = (text: string, maxCols: number): string => {
    if (text.length <= maxCols) return text
    return text.slice(0, maxCols)
  }

  const repaint = (): void => {
    const { rows, cols } = geometry()
    const panelTop = rows - height
    // Width budget for each row: full cols, but reserve 2 cols (1 leading
    // space + 1 trailing margin) so we never trigger DECAWM auto-wrap on
    // the bottom-most panel row (which sits 1 line above the status row).
    const maxCols = Math.max(0, cols - 2)
    let chunk = SAVE_CURSOR
    for (let i = 0; i < height; i++) {
      const row = panelTop + i
      chunk += `${ESC}${row};1H${ERASE_LINE}`
      const event = buffer[i]
      const ts = timestamps[i]
      if (event !== undefined && ts !== undefined) {
        const raw = formatEventLine(event, ts)
        const line = truncate(raw, maxCols)
        if (color) {
          chunk += `${FG_DIM} ${line}${FG_RESET}`
        } else {
          chunk += ` ${line}`
        }
      }
    }
    chunk += RESTORE_CURSOR
    safeWrite(chunk)
  }

  const eraseRows = (rows: number): void => {
    const panelTop = rows - height
    let chunk = SAVE_CURSOR
    for (let i = 0; i < height; i++) {
      chunk += `${ESC}${panelTop + i};1H${ERASE_LINE}`
    }
    chunk += RESTORE_CURSOR
    safeWrite(chunk)
  }

  // --- Install ---------------------------------------------------------
  pinScrollRegion(initial.rows)
  installed = true

  return {
    emit: (event: AgentEvent): void => {
      if (!installed) return
      buffer.push(event)
      timestamps.push(now())
      // Trim from the front so the latest `height` events are kept.
      while (buffer.length > height) {
        buffer.shift()
        timestamps.shift()
      }
      repaint()
    },
    onResize: (): void => {
      if (!installed) return
      const next = geometry()
      const reclamped = clampHeight(opts.height, next.rows)
      if (reclamped === 0) {
        // Terminal shrank below the floor — tear down rather than render a
        // broken panel. A subsequent grow-back is not auto-recovered: the
        // caller can wire a manual re-init if needed.
        const rows = next.rows
        eraseRows(rows)
        safeWrite(decstbmReset)
        installed = false
        return
      }
      // Re-allocate the ring buffer if the height changed.
      if (reclamped !== height) {
        height = reclamped
        // Truncate the existing buffer to the new height (drop the oldest).
        while (buffer.length > height) {
          buffer.shift()
          timestamps.shift()
        }
      }
      pinScrollRegion(next.rows)
      repaint()
    },
    teardown: (): void => {
      if (!installed) return
      const { rows } = geometry()
      eraseRows(rows)
      // Reset DECSTBM back to the full screen. The status bar's own
      // teardown (`installStatusBar.teardown`) writes the SAME reset; the
      // sequence is idempotent on every common terminal (xterm, iTerm,
      // VTE, conhost). When the status bar tears down AFTER us it will
      // simply re-issue the reset and clear its own row — net effect is
      // a clean screen either way.
      safeWrite(decstbmReset)
      installed = false
      // Drop refs so a stuck closure can't pin the event log.
      buffer = []
      timestamps = []
    },
  }
}
