/**
 * `/history` — recent turns + tool-call breadcrumb.
 *
 * Surfaces a compact, scannable summary of the live session so the operator
 * can answer "what did I just do?" without scrolling. Three subcommands:
 *
 *   - `/history`              → last N turns, one line each, with a tool-status
 *                               microbar (`✓✓✗` per turn).
 *   - `/history tools`        → last N tool calls (per-call OK / FAIL / retry).
 *   - `/history turn <N>`     → drill into a single turn (user prompt + the
 *                               full ordered tool sequence).
 *   - `/history --last <K>`   → cap override (any subcommand).
 *
 * Data sources (the surface picks the most accurate one available):
 *
 *   1. `messages: () => readonly Message[]` — REQUIRED. Drives turn boundaries
 *      (every `user` message opens a turn; subsequent `assistant` messages
 *      and tool_result blocks roll up under it). Tool-success is read from
 *      the `ToolResultBlock.is_error` field — the authoritative pairing point
 *      because the model itself sees this exact value.
 *   2. `events: () => Promise<readonly HistoryToolEvent[]>` — OPTIONAL. The
 *      envelope JSONL projection. Used PURELY for the wall-clock timestamp
 *      column in `/history tools` (messages do not carry per-tool ts). When
 *      absent the time column is rendered as `--:--:--` and exit code is
 *      still 0 — no fatal coupling.
 *
 * Default-OFF: without `ctx.history`, the command prints "history: not wired
 * in this surface" and exits 0 (parity with `/side`, `/skills`, etc.). No
 * fictitious zero-row table.
 *
 * Mutation policy: the command READS — never writes back to the message array,
 * never rewinds, never archives. `/history` is a viewport on top of the
 * session-commands' authoritative store; the two never collide.
 *
 * Slice discipline: lives in `src/apps/cli/**`. Imports `@/llm` for the
 * `Message` shape only (`type`-only on `Message` so the run-time graph stays
 * untouched). No envelope decoder is imported here — the surface composes the
 * `events` projection and passes a snapshot down, keeping this file fully
 * synchronous + unit-testable without a real filesystem.
 */

import type { Message } from "@/llm"
import { type DerivedTool, type DerivedTurn, deriveTurns } from "@/session/derive-turns"
import { errMessage } from "@/shared"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* injected state                                                      */
/* ------------------------------------------------------------------ */

/** A single envelope-derived tool event. The surface flattens an
 *  {@link EventToolInvoke}/{@link EventToolResult} pair into one entry —
 *  invokes carry the ts + input snippet, results carry the same ts + `ok`. */
export interface HistoryToolEvent {
  /** ISO-8601 timestamp from the envelope `ts` field. */
  readonly ts: string
  /** Tool name. */
  readonly tool: string
  /** Either an invocation (no `ok` yet) or a settled outcome. */
  readonly kind: "invoke" | "result"
  /** Settled outcome — present only on `kind === "result"`. */
  readonly ok?: boolean
  /** Optional one-line argument hint (e.g. "src/agent/loop.ts" for a Read,
   *  the pattern for a Grep, the cmd for a Bash). The surface picks the
   *  most identifying field; this is purely cosmetic for the breadcrumb. */
  readonly arg?: string
}

/** Session-time state injected by the surface (REPL / future shells).
 *  Read-only by design — callers MUST treat any returned array as frozen. */
export interface HistorySessionState {
  readonly messages: () => readonly Message[]
  readonly events?: () => Promise<readonly HistoryToolEvent[]>
  /** Per-turn user-prompt timestamps (epoch ms). Aligned by INDEX with the
   *  derived turns (turn 1 → index 0, etc.). Absent ⇒ rendered as `now` for
   *  the most recent, omitted otherwise — purely cosmetic. */
  readonly turnStartedAt?: () => readonly number[]
  /** Test seam — `Date.now()` by default. */
  readonly now?: () => number
}

/* ------------------------------------------------------------------ */
/* derive turns from the message array                                 */
/* ------------------------------------------------------------------ */

// Turn-reconstruction domain logic lives in core (`@/session/derive-turns`)
// so `/history`, `/inspect`, and the web daemon share ONE turn model. Imported
// at the top for the renderers below; re-exported here for back-compat with
// existing importers (e.g. the history-cmd test).
export { type DerivedTool, type DerivedTurn, deriveTurns }

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const HRULE = "─".repeat(48)

/** Single glyph for a settled / in-flight tool. */
const toolGlyph = (ok: boolean | undefined): string => (ok === undefined ? "·" : ok ? "✓" : "✗")

/** Build the per-turn status microbar: one glyph per tool. */
const statusBar = (tools: readonly DerivedTool[]): string => {
  if (tools.length === 0) return ""
  const glyphs = tools.map((t) => toolGlyph(t.ok))
  return `(${glyphs.join("")})`
}

/** Anything under this delta is rendered as "now" so the most-recent line
 *  reads natural while the user is in the middle of a turn. 5 s mirrors the
 *  same threshold used by the `session ls` relative-time column. */
const NOW_THRESHOLD_MS = 5_000

/** Format `epoch-ms` as a coarse "Nm ago" / "Nh ago" / "Nd ago".
 *  Returns "now" for deltas under {@link NOW_THRESHOLD_MS}. */
const relAgo = (now: number, then: number | undefined): string => {
  if (then === undefined) return "—"
  const delta = Math.max(0, now - then)
  if (delta < NOW_THRESHOLD_MS) return "now"
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Format an envelope ISO ts as HH:MM:SS local time. Returns `--:--:--` on
 *  shape mismatch so the fallback row still renders without throwing. */
const formatClock = (iso: string): string => {
  // Accept the strict shape from the envelope schema (always Z-suffixed UTC).
  // We render LOCAL HH:MM:SS so the user reads wall-clock as printed by their
  // shell. JS Date handles the conversion.
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return "--:--:--"
  const pad = (n: number): string => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const renderTurnsList = (
  ctx: SlashContext,
  turns: readonly DerivedTurn[],
  cap: number,
  startedAt: readonly number[] | undefined,
  now: number,
): void => {
  const slice = turns.slice(-cap)
  const total = turns.length
  if (slice.length === 0) {
    ctx.out("(no turns yet)\n")
    return
  }
  ctx.out(`─ Recent turns (${slice.length} of ${total} shown) ${HRULE}\n\n`)
  // Newest first for scan-from-top UX.
  for (let i = slice.length - 1; i >= 0; i--) {
    const t = slice[i] as DerivedTurn
    const tsIdx = turns.indexOf(t)
    const startedMs = startedAt?.[tsIdx]
    const ago = relAgo(now, startedMs)
    const bar = statusBar(t.tools)
    const tools = t.tools.length === 1 ? "1 tool" : `${t.tools.length} tools`
    const head = `Turn ${t.index} · ${ago} · ${tools}${bar !== "" ? ` ${bar}` : ""}`
    const body = truncate(t.summary, 60)
    ctx.out(`  ${head}  ${body}\n`)
  }
  ctx.out(`${HRULE}\n`)
}

/** Group invokes by tool name into a queue we can `.shift()` in arrival order. */
const buildTsQueue = (events: readonly HistoryToolEvent[] | undefined): Map<string, string[]> => {
  const tsQueue = new Map<string, string[]>()
  if (events === undefined) return tsQueue
  for (const ev of events) {
    if (ev.kind !== "invoke") continue
    const arr = tsQueue.get(ev.tool) ?? []
    arr.push(ev.ts)
    tsQueue.set(ev.tool, arr)
  }
  return tsQueue
}

/** Decide the glyph + trailing label for one tool row. Retry fires when an
 *  OK tool follows a FAIL of the same name back-to-back (best-effort: no arg
 *  fingerprint is available from `DerivedTool`). */
const formatToolRow = (
  t: DerivedTool,
  prev: DerivedTool | undefined,
): { glyph: string; tail: string } => {
  const isRetry = prev !== undefined && prev.name === t.name && prev.ok === false && t.ok === true
  if (isRetry) return { glyph: "↻", tail: "  (retry, ✓)" }
  const glyph = toolGlyph(t.ok)
  if (t.ok === false) return { glyph, tail: "  (failed)" }
  if (t.ok === undefined) return { glyph, tail: "  (in-flight)" }
  return { glyph, tail: "" }
}

const renderToolsList = (
  ctx: SlashContext,
  turns: readonly DerivedTurn[],
  events: readonly HistoryToolEvent[] | undefined,
  cap: number,
): void => {
  // Build the canonical tool sequence from the message array. Envelope events
  // (when present) supply the wall-clock timestamp via a tool_use_id ⇄ event
  // lookup — but the LIST itself is anchored to messages so a turn-in-flight
  // (no event yet) still renders.
  const flat: DerivedTool[] = []
  for (const t of turns) flat.push(...t.tools)
  const slice = flat.slice(-cap)
  if (slice.length === 0) {
    ctx.out("(no tool calls yet)\n")
    return
  }
  const tsQueue = buildTsQueue(events)
  ctx.out(`─ Recent tool calls ${HRULE}\n\n`)
  let prev: DerivedTool | undefined
  for (const t of slice) {
    const tsArr = tsQueue.get(t.name)
    const ts = tsArr !== undefined && tsArr.length > 0 ? tsArr.shift() : undefined
    const clock = ts !== undefined ? formatClock(ts) : "--:--:--"
    const { glyph, tail } = formatToolRow(t, prev)
    ctx.out(`  ${glyph} ${clock}  ${t.name.padEnd(8)}${tail}\n`)
    prev = t
  }
  ctx.out(`${HRULE}\n`)
}

const renderTurnDetail = (
  ctx: SlashContext,
  turns: readonly DerivedTurn[],
  turnNumber: number,
): number => {
  const t = turns.find((x) => x.index === turnNumber)
  if (t === undefined) {
    ctx.err(`/history: turn ${turnNumber} not found (have ${turns.length} turn(s))\n`)
    return 1
  }
  ctx.out(`─ Turn ${t.index} ${HRULE}\n\n`)
  ctx.out(`  prompt: ${truncate(t.summary, 180)}\n`)
  ctx.out(`  tools:  ${t.tools.length}${t.tools.length === 0 ? " (none)" : ""}\n`)
  for (let i = 0; i < t.tools.length; i++) {
    const tl = t.tools[i] as DerivedTool
    ctx.out(`    ${(i + 1).toString().padStart(2)}. ${toolGlyph(tl.ok)} ${tl.name}\n`)
  }
  ctx.out(`${HRULE}\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* argv parsing                                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_N_FALLBACK = 10

/** Resolve the cap. CLI `--last <K>` wins; then `QUANTA_HISTORY_DEFAULT_N`;
 *  finally {@link DEFAULT_N_FALLBACK}. Non-positive / non-finite values are
 *  treated as "use default" so a typo cannot wipe the entire view. */
export const resolveCap = (cli: number | undefined, env: string | undefined): number => {
  if (cli !== undefined && Number.isFinite(cli) && cli > 0) return Math.floor(cli)
  if (env !== undefined && env !== "") {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return DEFAULT_N_FALLBACK
}

export interface HistoryCmdArgs {
  readonly sub: "turns" | "tools" | "turn"
  readonly turnArg?: number
  readonly last?: number
}

/** Parse a `--last <K>` / `--last=K` token; returns the value or throws. */
const parseLastValue = (raw: string): number => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`/history: --last expects a positive integer (got: ${raw})`)
  }
  return Math.floor(n)
}

interface SplitArgs {
  readonly positional: readonly string[]
  readonly last?: number
}

const splitFlagsAndPositional = (args: readonly string[]): SplitArgs => {
  let last: number | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === "--last") {
      const next = args[i + 1]
      if (next === undefined) throw new Error("/history: --last requires a value")
      last = parseLastValue(next)
      i += 1
      continue
    }
    if (a.startsWith("--last=")) {
      last = parseLastValue(a.slice("--last=".length))
      continue
    }
    if (a.startsWith("--")) throw new Error(`/history: unknown flag: ${a}`)
    positional.push(a)
  }
  return last !== undefined ? { positional, last } : { positional }
}

const buildToolsArgs = (
  positional: readonly string[],
  last: number | undefined,
): HistoryCmdArgs => {
  if (positional.length > 1) {
    throw new Error(
      `/history: 'tools' takes no positional args (got: ${positional.slice(1).join(" ")})`,
    )
  }
  return last !== undefined ? { sub: "tools", last } : { sub: "tools" }
}

const buildTurnArgs = (positional: readonly string[], last: number | undefined): HistoryCmdArgs => {
  const arg = positional[1]
  if (arg === undefined) throw new Error("/history: 'turn' requires a turn number")
  const n = Number(arg)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`/history: turn expects a positive integer (got: ${arg})`)
  }
  if (positional.length > 2) {
    throw new Error(
      `/history: 'turn' takes one argument (got extra: ${positional.slice(2).join(" ")})`,
    )
  }
  return last !== undefined ? { sub: "turn", turnArg: n, last } : { sub: "turn", turnArg: n }
}

/** Parse the argv tail after `/history`. Throws on a shape error. */
export const parseHistoryArgs = (args: readonly string[]): HistoryCmdArgs => {
  const { positional, last } = splitFlagsAndPositional(args)
  if (positional.length === 0) {
    return last !== undefined ? { sub: "turns", last } : { sub: "turns" }
  }
  const head = positional[0] as string
  if (head === "tools") return buildToolsArgs(positional, last)
  if (head === "turn") return buildTurnArgs(positional, last)
  throw new Error(`/history: unknown subcommand: ${head} (expected: tools | turn <N>)`)
}

/* ------------------------------------------------------------------ */
/* command entry                                                       */
/* ------------------------------------------------------------------ */

export const historyCmd: SlashCommand = {
  name: "/history",
  describe: "Show recent turns or tool calls (subcommands: tools, turn <N>)",
  category: "history",
  async run(args, ctx) {
    if (ctx.history === undefined) {
      ctx.out("/history: not wired in this surface\n")
      return 0
    }
    let parsed: HistoryCmdArgs
    try {
      parsed = parseHistoryArgs(args)
    } catch (e) {
      ctx.err(`${errMessage(e)}\n`)
      return 1
    }
    const cap = resolveCap(parsed.last, process.env.QUANTA_HISTORY_DEFAULT_N)
    const messages = ctx.history.messages()
    const turns = deriveTurns(messages)
    const now = ctx.history.now?.() ?? Date.now()
    const startedAt = ctx.history.turnStartedAt?.()
    if (parsed.sub === "turns") {
      renderTurnsList(ctx, turns, cap, startedAt, now)
      return 0
    }
    if (parsed.sub === "tools") {
      const events = ctx.history.events !== undefined ? await ctx.history.events() : undefined
      renderToolsList(ctx, turns, events, cap)
      return 0
    }
    // `turn <N>`
    return renderTurnDetail(ctx, turns, parsed.turnArg as number)
  },
}
