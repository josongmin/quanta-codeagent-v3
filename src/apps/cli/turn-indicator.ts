/**
 * Live turn indicator — spinner + elapsed + (optional) live token counter.
 *
 * Bridges the per-turn LLM round-trip into the existing {@link StatusBar}
 * `transient` seam so the user sees motion (spinner + elapsed clock) while the
 * model thinks, instead of the dead-air gap that today's CLI surfaces between
 * `quanta› <prompt>` and the first streamed token.
 *
 * Design constraints (pin):
 *   - **Default-OFF byte-identical** behaviour for non-TTY surfaces (pipes,
 *     redirects, eval/bench): when `process.stdout.isTTY === false` we either
 *     never construct the indicator (caller's job) OR `start/stop/update` all
 *     become no-ops. The caller may also gate by `QUANTA_SPINNER` env (read at
 *     the call site so this module remains env-free + unit-testable).
 *   - **Pure DI**: every collateral (`statusBar`, `now`, `setInterval` /
 *     `clearInterval`) is injectable so tests can drive the clock and snapshot
 *     the `statusBar.transient` call sequence without a real terminal.
 *   - **No source-of-truth duplication**: token counts come from the existing
 *     `{type:"usage"}` AgentEvent (wired through a tee StreamPort by the
 *     caller). This module only renders what was handed to it.
 *   - **Slice-isolation**: imports from `./status-bar` only — no `@/agent`,
 *     no `@/stream`, no `@/llm` (the caller already does the cross-slice
 *     plumbing; we just render).
 */

import { cyan, dim, gray, green, magenta, yellow } from "@/ui"
import type { StatusBar } from "./status-bar"

/** Default braille glyph cycle (10 frames). Same set Codex / Claude Desktop
 *  use for their "thinking…" indicator; cycles cleanly at any frame rate. */
export const DEFAULT_GLYPHS: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Visual separator between indicator segments. A thin middle-dot keeps the
 *  line dev-paper feel — same character spacing as `·` but renders quieter
 *  when wrapped in `dim()`. The two-space halo gives each segment a clear
 *  visual unit without bunching them tight on smaller terminals. */
const SEP = dim("·")

/** Default frame interval (ms). 80 ms ⇒ 12.5 fps — fast enough to look smooth,
 *  slow enough to keep the repaint cost negligible. */
export const DEFAULT_INTERVAL_MS = 80

export interface UsageDelta {
  inputTokens?: number
  outputTokens?: number
  /** Optional cost in USD (caller computes from model + tokens — we just
   *  render). Absent ⇒ token-only display. */
  costUsd?: number
}

export interface TurnIndicator {
  /** Begin painting the spinner via the injected statusBar's transient seam.
   *  Idempotent: a second `start()` without an intervening `stop()` is a
   *  no-op (no double timer, no double paint). */
  start(): void
  /** Stop the spinner and ask the statusBar to revert to its default text.
   *  Idempotent: a `stop()` without a prior `start()` is a no-op. */
  stop(): void
  /** Fold a usage delta into the live counter. Reflected on the NEXT frame
   *  (we don't force-repaint here — the timer drives all paints so the
   *  display rate stays bounded). */
  updateUsage(delta: UsageDelta): void
  /** Mark the first chunk of the assembled stream as observed. Switches the
   *  glyph line from "thinking… <elapsed>" to "streaming · <elapsed> · ttft
   *  <…> · …". Idempotent + one-shot per turn (subsequent calls are ignored
   *  until `stop()` resets the latch). */
  markFirstChunk(): void
}

export interface TurnIndicatorOptions {
  /** Inject the StatusBar transient seam. */
  statusBar: StatusBar
  /** Spinner glyph cycle. Default braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`. */
  glyphs?: readonly string[]
  /** Frame interval (ms). Default 80. */
  intervalMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Test seam for the interval timer. Defaults to the platform globals.
   *  Both must be supplied or the platform defaults are used (we never mix). */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
  /** When `false`, every method is a no-op — used to honour `!stdout.isTTY`
   *  without forcing the caller to branch around the indicator. Default
   *  `true` (the caller's env/TTY gate decides whether to even construct
   *  one — but this option lets composite callers degrade gracefully). */
  enabled?: boolean
}

/** Format an elapsed-ms delta as "1.2s" / "12.3s" / "1m23s". Capped at
 *  hours-not-needed because a single turn that runs > 1h would have other
 *  problems we'd already be surfacing through dashboards. */
const formatElapsed = (ms: number): string => {
  if (ms < 0) return "0.0s"
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

/** Compact token formatter — "1,247" / "12.3k" / "1.20M". Keeps the spinner
 *  line under ~80 cols even on huge contexts. */
const formatTokens = (n: number): string => {
  if (n < 1000) return n.toString()
  if (n < 10_000) return n.toLocaleString("en-US")
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Format an optional USD cost. Absent ⇒ empty string (caller appends with
 *  a leading separator only when non-empty). */
const formatCost = (usd: number | undefined): string => {
  if (usd === undefined || !Number.isFinite(usd)) return ""
  // Fine-grained decimals for sub-dollar amounts so a $0.0143 cost on a
  // small turn doesn't render as $0.01 and look like a rounding bug. The
  // 4-decimal upper bound (< $0.1) covers the realistic "cheap turn"
  // range (~$0.0001..$0.05); 3 decimals for $0.1..<$1; 2 decimals at $1+.
  if (usd < 0.1) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Mutable per-turn render state. Held in one object so each frame is a pure
 *  read; `updateUsage`/`markFirstChunk` just patch fields. */
interface RenderState {
  startedAt: number
  firstChunkAt: number | undefined
  inputTokens: number
  outputTokens: number
  costUsd: number | undefined
  frame: number
}

const renderLine = (state: RenderState, glyphs: readonly string[], nowMs: number): string => {
  const glyph = cyan(glyphs[state.frame % glyphs.length] ?? "·")
  const elapsed = formatElapsed(nowMs - state.startedAt)

  // Pre-first-chunk: short "thinking…" line — no token counts yet.
  if (state.firstChunkAt === undefined) {
    return `${glyph} ${dim("thinking…")} ${cyan(elapsed)}`
  }

  const ttft = formatElapsed(state.firstChunkAt - state.startedAt)
  const parts: string[] = [glyph, dim("streaming"), cyan(elapsed), `${dim("ttft")} ${yellow(ttft)}`]
  if (state.inputTokens > 0) parts.push(`${magenta(formatTokens(state.inputTokens))} ${dim("in")}`)
  if (state.outputTokens > 0) parts.push(`${green(formatTokens(state.outputTokens))} ${dim("out")}`)
  const cost = formatCost(state.costUsd)
  if (cost !== "") parts.push(gray(cost))
  return parts.join(` ${SEP} `)
}

/** Build a turn indicator bound to the injected {@link StatusBar}. See
 *  {@link TurnIndicator} for the lifecycle contract. */
export const createTurnIndicator = (opts: TurnIndicatorOptions): TurnIndicator => {
  const enabled = opts.enabled ?? true
  const glyphs = opts.glyphs ?? DEFAULT_GLYPHS
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = opts.now ?? Date.now
  const setIv = opts.setInterval ?? setInterval
  const clearIv = opts.clearInterval ?? clearInterval

  let handle: ReturnType<typeof setInterval> | null = null
  let state: RenderState | null = null

  const paint = (): void => {
    if (state === null) return
    const line = renderLine(state, glyphs, now())
    // We pass a long transient ttl (one frame plus a generous margin) so the
    // statusBar's auto-revert never races our next tick — we always repaint
    // before the previous transient could expire. `stop()` is the only path
    // that clears the transient (via `clearTransient`).
    opts.statusBar.transient(line, intervalMs * 4)
    state.frame += 1
  }

  return {
    start: (): void => {
      if (!enabled) return
      if (handle !== null) return // idempotent
      state = {
        startedAt: now(),
        firstChunkAt: undefined,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: undefined,
        frame: 0,
      }
      // Paint the first frame synchronously so the user sees motion BEFORE
      // the first tick of the timer fires (which would otherwise delay the
      // first frame by `intervalMs`).
      paint()
      handle = setIv(paint, intervalMs)
    },
    stop: (): void => {
      if (!enabled) return
      if (handle === null) return // idempotent
      clearIv(handle)
      handle = null
      state = null
      // Hand the row back to the statusBar's default text. This is the
      // SOLE place we cancel the transient; every other path lets the
      // transient auto-extend from the next paint frame.
      opts.statusBar.clearTransient()
    },
    updateUsage: (delta: UsageDelta): void => {
      if (!enabled || state === null) return
      // Tokens are reported as cumulative counts in the `usage` AgentEvent
      // (one emit per LLM call), so we ASSIGN (last-writer-wins) rather
      // than accumulate. The two `undefined` paths are no-ops so a partial
      // delta (e.g. cost only) doesn't clobber the token half.
      if (delta.inputTokens !== undefined) state.inputTokens = delta.inputTokens
      if (delta.outputTokens !== undefined) state.outputTokens = delta.outputTokens
      if (delta.costUsd !== undefined) state.costUsd = delta.costUsd
    },
    markFirstChunk: (): void => {
      if (!enabled || state === null) return
      if (state.firstChunkAt !== undefined) return // one-shot per turn
      state.firstChunkAt = now()
    },
  }
}

/** Test/composition helper: should the indicator be enabled in the current
 *  environment? Returns `false` when stdout is NOT a TTY (pipes, redirects,
 *  eval/bench harnesses) OR when `QUANTA_SPINNER === "0"`. Pure function —
 *  reads no globals other than the `env` and `isTTY` arguments. */
export const isIndicatorEnabled = (env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean => {
  if (isTTY !== true) return false
  const knob = env.QUANTA_SPINNER
  // Default-ON when TTY: only an explicit `0` (or `false`/`off`) disables.
  if (knob === undefined) return true
  const norm = knob.trim().toLowerCase()
  return norm !== "0" && norm !== "false" && norm !== "off" && norm !== "no"
}
