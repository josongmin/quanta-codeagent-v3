/**
 * CLI renderer for parallel-lane progress (subscribes to the {@link laneProgress}
 * bus emitted at the repair-breadth / verify-select fork sites).
 *
 * Two modes, chosen by the terminal:
 *  - TTY  → a bottom-anchored, live-redrawing multi-line PANEL, one line per
 *    active lane (`⑂ repair-breadth#2  turn 7 · ✎ edit   12s`). Coordinated with
 *    all other stderr output through the {@link TerminalIo} seam: any log line
 *    first erases the panel, writes, then the panel redraws below — so logger
 *    output and the panel never corrupt each other.
 *  - non-TTY (CI, nohup, supervised EC2) → plain PREFIXED LOG LINES
 *    (`⑂ [repair-breadth#2] ✎ edit`), no ANSI, greppable, survives redirection.
 *
 * Gate: ON by default; `QUANTA_BENCH_LANE_PROGRESS=0/off/false` disables (then the
 * renderer never subscribes and the bus stays inert — byte-identical output).
 * Display-only: writes to stderr, never stdout, never the report.
 */
import { type LaneProgressEvent, laneProgress } from "@/runner/batch/eval/lane-progress"
import { isFalsyToken } from "@/shared"
import { getTerminalIo, setTerminalIo, type TerminalIo } from "@/shared/terminal-io"

interface LaneState {
  turn: number
  tool?: string
  done: boolean
  ok?: boolean
  patchBytes?: number
  startedMs: number
}

/** Stable-ish 8-color ANSI palette keyed by lane label so a lane keeps one hue. */
const laneAnsiColor = (lane: string): string => {
  let h = 0
  for (let i = 0; i < lane.length; i++) h = (h * 31 + lane.charCodeAt(i)) >>> 0
  return `\x1b[38;5;${[39, 43, 78, 113, 148, 178, 175, 141][h % 8]}m`
}
const RESET = "\x1b[0m"
const DIM = "\x1b[2m"

const applyEvent = (lanes: Map<string, LaneState>, e: LaneProgressEvent, nowMs: number): void => {
  const s = lanes.get(e.lane) ?? { turn: 0, done: false, startedMs: nowMs }
  if (e.kind === "start") {
    lanes.set(e.lane, { turn: 0, done: false, startedMs: nowMs })
    return
  }
  if (e.kind === "turn") s.turn = e.turn ?? s.turn
  else if (e.kind === "tool") {
    s.turn = e.turn ?? s.turn
    if (e.tool !== undefined) s.tool = e.tool
  } else if (e.kind === "done") {
    s.done = true
    if (e.ok !== undefined) s.ok = e.ok
    if (e.patchBytes !== undefined) s.patchBytes = e.patchBytes
  }
  lanes.set(e.lane, s)
}

const fmtElapsed = (ms: number): string => `${Math.round(ms / 1000)}s`

/** TTY panel: one padded line per lane, colored, done lanes marked ✓/✗. */
const panelLines = (lanes: Map<string, LaneState>, nowMs: number): string[] =>
  [...lanes.entries()].map(([lane, s]) => {
    const col = laneAnsiColor(lane)
    const el = fmtElapsed(nowMs - s.startedMs)
    const body = s.done
      ? `${s.ok ? "✓" : "✗"} done${s.patchBytes ? ` · ${s.patchBytes}B` : ""}`
      : `turn ${s.turn}${s.tool ? ` · ✎ ${s.tool}` : " · …"}`
    return `${col}⑂ ${lane}${RESET}  ${body}  ${DIM}${el}${RESET}`
  })

/** non-TTY: a single log line for the meaningful transitions (skip bare turns). */
const logLine = (e: LaneProgressEvent): string | undefined => {
  if (e.kind === "start") return `⑂ [${e.lane}] ▷ start`
  if (e.kind === "tool") return `⑂ [${e.lane}] ✎ ${e.tool} (turn ${e.turn})`
  if (e.kind === "done")
    return `⑂ [${e.lane}] ${e.ok ? "✓" : "✗"} done${e.patchBytes ? ` · ${e.patchBytes}B` : ""}`
  return undefined // bare "turn" events are too noisy for a flat log
}

/**
 * Start the renderer. Returns a `stop()` that unsubscribes, erases the panel, and
 * restores the original terminal ports. Safe to call `stop()` more than once.
 */
export const startLaneProgressRenderer = (nowMs: () => number = Date.now): (() => void) => {
  if (isFalsyToken(process.env.QUANTA_BENCH_LANE_PROGRESS)) return () => {}

  const io = getTerminalIo()
  const origStderr = io.stderr
  const lanes = new Map<string, LaneState>()

  // non-TTY: flat prefixed log lines (no ANSI, redirection-safe).
  if (io.stderrIsTTY !== true) {
    return laneProgress.subscribe((e) => {
      const line = logLine(e)
      if (line !== undefined) origStderr(`${line}\n`)
    })
  }

  // TTY: bottom-anchored panel coordinated with all other stderr writes.
  let panelHeight = 0
  const clearPanel = (): void => {
    if (panelHeight > 0) origStderr(`\x1b[${panelHeight}A\x1b[0J`) // cursor up N, clear to end
    panelHeight = 0
  }
  const drawPanel = (): void => {
    const lines = panelLines(lanes, nowMs())
    if (lines.length > 0) origStderr(`${lines.join("\n")}\n`)
    panelHeight = lines.length
  }
  const redraw = (): void => {
    clearPanel()
    drawPanel()
  }

  // Any OTHER stderr write (logger.info) erases the panel first, writes, then the
  // panel redraws below it — the ink/ora bottom-block coordination pattern.
  const coordinated: TerminalIo = {
    ...io,
    stderr: (chunk: string) => {
      clearPanel()
      origStderr(chunk)
      drawPanel()
    },
  }
  setTerminalIo(coordinated)

  const unsub = laneProgress.subscribe((e) => {
    applyEvent(lanes, e, nowMs())
    redraw()
  })

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    unsub()
    clearPanel()
    setTerminalIo(io) // restore original ports
  }
}
