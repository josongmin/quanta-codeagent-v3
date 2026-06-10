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

import { cyan, dim, gray, green, magenta } from "@/ui"
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

/** Number of trailing (tokens, timestamp) samples retained for the live
 *  output-throughput (`tok/s`) measurement.
 *
 *  WHY a windowed slope, not a session average: rate = Δtokens / Δtime taken
 *  over the OLDEST..NEWEST sample currently in the ring. A short trailing
 *  window means a burst-then-stall visibly drops as the fast samples age out,
 *  instead of a session-wide mean that flattens stalls into a misleading
 *  steady number. This is a MEASUREMENT (an exact slope over an explicit set
 *  of observed points), not a heuristic — there is no decay factor, no
 *  threshold, no fudge. The single named constant is the window *length*.
 *
 *  WHY 8: `usage` events on most providers arrive roughly per-chunk/flush, so
 *  ~8 samples spans the last fraction of a second to a couple seconds of real
 *  flow — recent enough to read as "right now", long enough that a single
 *  jittery inter-arrival gap can't dominate the slope. The ring is decoupled
 *  from the 80 ms repaint cadence on purpose: repaint frequency must not
 *  influence the measured rate. */
export const RATE_WINDOW_SAMPLES = 8

export interface UsageDelta {
  inputTokens?: number
  outputTokens?: number
  /** Optional cost in USD (caller computes from model + tokens — we just
   *  render). Absent ⇒ token-only display. */
  costUsd?: number
  /** Whether `outputTokens` is provider-authoritative (`true`) or locally
   *  estimated (`false`, from the live-usage decorator's chars/4 fallback). A
   *  false reading renders with a `~` prefix. Omitted ⇒ treated as exact
   *  (the terminal `usage` AgentEvent carries no flag and IS authoritative). */
  exact?: boolean
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
   *  glyph line from "thinking… <elapsed>" to "streaming · <elapsed> · …".
   *  Idempotent + one-shot per turn (subsequent calls are ignored until
   *  `stop()` resets the latch). TTFT itself is NOT rendered here — it is a
   *  per-turn scalar (constant for the whole stream), so repainting it every
   *  frame is pure noise; telemetry captures it via `turn-timing`. */
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

/** One observed output-token reading at a wall-clock instant (from the
 *  injected `now`). The ring of these drives the live `tok/s` slope. */
interface RateSample {
  tokens: number
  at: number
}

/** Compute output throughput (tok/s) from the trailing sample ring, or
 *  `undefined` when no meaningful rate exists yet.
 *
 *  Returns `undefined` (NOT `0`) when:
 *    - fewer than 2 samples exist (a single point has no slope), OR
 *    - the oldest and newest samples share a timestamp (Δtime === 0 ⇒ would
 *      divide by zero / produce Infinity), OR
 *    - the token delta is non-positive (no forward flow ⇒ nothing to show).
 *
 *  Rate is the slope OLDEST→NEWEST across the whole retained window, so it
 *  reflects the recent trailing window rather than a session-long average. */
const computeRate = (samples: readonly RateSample[]): number | undefined => {
  if (samples.length < 2) return undefined
  const oldest = samples[0]
  const newest = samples[samples.length - 1]
  if (oldest === undefined || newest === undefined) return undefined
  const dt = newest.at - oldest.at
  if (dt <= 0) return undefined
  const dTokens = newest.tokens - oldest.tokens
  if (dTokens <= 0) return undefined
  return (dTokens / dt) * 1000 // tokens-per-ms → tokens-per-second
}

/** Append an output-token reading to the trailing ring, mutating `samples` in
 *  place. Only FORWARD motion is recorded (a repeated/idle `usage` emit that
 *  doesn't advance the cumulative output count is dropped so it can't pollute
 *  the slope with a zero-Δtoken point). The ring is capped at
 *  {@link RATE_WINDOW_SAMPLES}; the oldest sample ages out past the cap. */
const pushRateSample = (samples: RateSample[], tokens: number, at: number): void => {
  const prev = samples[samples.length - 1]
  if (prev !== undefined && tokens <= prev.tokens) return
  samples.push({ tokens, at })
  if (samples.length > RATE_WINDOW_SAMPLES) samples.shift()
}

/** Mutable per-turn render state. Held in one object so each frame is a pure
 *  read; `updateUsage`/`markFirstChunk` just patch fields. */
interface RenderState {
  startedAt: number
  firstChunkAt: number | undefined
  inputTokens: number
  outputTokens: number
  /** True ⇒ `outputTokens` is provider-authoritative; false ⇒ estimated
   *  (rendered with a `~` prefix). */
  outputExact: boolean
  costUsd: number | undefined
  frame: number
  /** Trailing ring of output-token readings (max {@link RATE_WINDOW_SAMPLES});
   *  oldest first. Only appended when output actually advances. */
  rateSamples: RateSample[]
}

/** Render the output-token count with a `~` prefix when the value is a local
 *  estimate (not yet provider-authoritative). Mirrors Claude Code's rising
 *  "· N tokens"; the tilde keeps the estimate honest. */
const formatOutTokens = (n: number, exact: boolean): string =>
  exact ? formatTokens(n) : `~${formatTokens(n)}`

const renderLine = (state: RenderState, glyphs: readonly string[], nowMs: number): string => {
  const glyph = cyan(glyphs[state.frame % glyphs.length] ?? "·")
  const elapsed = formatElapsed(nowMs - state.startedAt)

  // Pre-first-chunk "thinking…" line. Reasoning models stream `thinking_delta`
  // here (no visible text yet ⇒ `markFirstChunk` hasn't fired), so the live
  // output-token count IS already climbing — surface it (Claude-Code parity:
  // "thinking… · N tokens") instead of a bare clock.
  if (state.firstChunkAt === undefined) {
    const base = `${glyph} ${dim("thinking…")} ${cyan(elapsed)}`
    return state.outputTokens > 0
      ? `${base} ${SEP} ${green(formatOutTokens(state.outputTokens, state.outputExact))} ${dim("tokens")}`
      : base
  }

  const parts: string[] = [glyph, dim("streaming"), cyan(elapsed)]
  if (state.inputTokens > 0) parts.push(`${magenta(formatTokens(state.inputTokens))} ${dim("in")}`)
  if (state.outputTokens > 0) {
    parts.push(`${green(formatOutTokens(state.outputTokens, state.outputExact))} ${dim("out")}`)
  }
  // Live output throughput — additive: only appears once the trailing ring
  // holds ≥2 forward-flowing samples (computeRate ⇒ undefined otherwise, so
  // no `0 tok/s` noise / no NaN before flow starts). Repaint cadence does NOT
  // feed this number; the value is the slope over token-arrival samples.
  const rate = computeRate(state.rateSamples)
  if (rate !== undefined) parts.push(`${green(formatTokens(Math.round(rate)))} ${dim("tok/s")}`)
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
        outputExact: false,
        costUsd: undefined,
        frame: 0,
        rateSamples: [],
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
      if (delta.outputTokens !== undefined) {
        // Sample the OUTPUT cumulative count at the injected clock instant —
        // the same `now` the spinner already uses (no second wall-clock). We
        // record on the token-delta boundary (here), NOT on the 80 ms frame
        // tick, so the measured rate is decoupled from repaint cadence.
        pushRateSample(state.rateSamples, delta.outputTokens, now())
        state.outputTokens = delta.outputTokens
        // Omitted flag ⇒ authoritative (the terminal `usage` AgentEvent). The
        // live-usage decorator passes an explicit `exact` per progress tick.
        state.outputExact = delta.exact ?? true
      }
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
