/**
 * `/replay <session-id> [--at <turn>] [--from <toolCallId>]` — sibling surface
 * to ADR-0239's live `/debug` stream tracer, but driven from a recorded JSONL
 * envelope log instead of the live agent loop. Sister UX: same one-line-per-
 * event shape, same column ordering, same color palette — the only difference
 * is the source.
 *
 * Why a separate file (not a merge with `debug-tracer.ts`):
 *   - `debug-tracer.ts` lives inside the ADR-0239 slice and consumes a LIVE
 *     `AgentEvent` stream (the in-memory typed shape). This file consumes the
 *     ON-DISK {@link SessionEnvelopeRecord} shape (decoded by `@/session`).
 *     The two shapes overlap conceptually but differ in field names + types
 *     — pinning them together at this stage would force one of the two to
 *     accept the other's shape and we lose the JSONL invariant.
 *   - Slice-fence: `debug-tracer.ts` is sealed by ADR-0239. This slice (a new
 *     ADR) sits adjacent. A future consolidation can extract a shared
 *     formatter; for now the visual parity is held by convention + the
 *     hellgate (which pins the column layout literally).
 *
 * No LLM call, no on-disk mutation, no envelope variant added. Pure read +
 * format + write to the injected `out` sink.
 */

import type { EventMsgRecord, SessionEnvelopeRecord } from "@/session"

/* ------------------------------------------------------------------ */
/* public interface                                                    */
/* ------------------------------------------------------------------ */

export interface ReplayCmdOpts {
  /** Resolve a session id → JSONL file path. Caller injects. Returning
   *  `undefined` ⇒ surface prints "session <id> not found" + exit 1. */
  readonly resolveSession: (id: string) => Promise<string | undefined>
  /** Iterate envelopes from a path. Adapter over `iterateSessionFile` (the
   *  REPL-side composer is responsible for unwrapping the
   *  `Result<Record, Error>` shape — at this command boundary the events are
   *  already validated). */
  readonly iterate: (path: string) => AsyncIterable<SessionEnvelopeRecord>
  /** Sink — `process.stdout.write` in prod, buffer in tests. */
  readonly out: (chunk: string) => void
  /** Color ANSI. Defaults to `stdout.isTTY`. */
  readonly color?: boolean
  /** Per-event pacing in ms — 0 = no pacing (default). Test seam: inject a
   *  no-op sleep so tests don't hang. When `intervalMs > 0`, `sleep` is
   *  called between every consecutive pair of rendered frames (N-1 calls). */
  readonly pace?: { sleep: (ms: number) => Promise<void>; intervalMs: number }
  /** Optional filter — only events for this turn, and/or starting from this
   *  toolCallId. When both are present they AND together. */
  readonly filter?: { atTurn?: number; fromToolCallId?: string }
  /** Wall-clock — test seam (`() => Date.now()` in prod). The header
   *  footer prints elapsed `(end - start) / 1000`s. Default: `Date.now`. */
  readonly now?: () => number
}

export interface ReplayCmdResult {
  readonly exitCode: number
  readonly framesRendered: number
  readonly message?: string
}

/* ------------------------------------------------------------------ */
/* ANSI                                                                */
/* ------------------------------------------------------------------ */

/** Minimal ANSI palette. Keep in sync with the visual style of ADR-0239's
 *  `debug-tracer.ts` (header rules use the same color, event types use the
 *  same dim/cyan/magenta pattern). When `color === false` ALL of these
 *  collapse to the empty string by virtue of `c()` below. */
const ANSI = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
} as const

const c = (use: boolean | undefined, code: string, text: string): string =>
  use === true ? `${code}${text}${ANSI.reset}` : text

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

/** Truncate a free-form string to `max` chars, append `…` when cut. Bytewise
 *  — adequate for the in-line `reason` strings we render (ASCII-dominant).
 *  Multi-byte safety lives in `slash-commands.ts#truncateGraphemes` for
 *  longer / user-facing fields; here the cap is tight (60-120) so a multi-
 *  byte split is invisible in practice. */
const trunc = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** ISO timestamp → `HH:MM:SS.mmm` local-style window. We render the WALL
 *  clock from the envelope `ts` field, not from `now()` — replay is meant
 *  to show "when this happened originally". */
const fmtTs = (iso: string): string => {
  // Defensive parse: malformed iso ⇒ pass-through (truncated). The envelope
  // schema constrains `ts` to a strict ISO-8601 regex so this only triggers
  // on shape changes we forgot to mirror here.
  const m = iso.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/)
  if (m === null) return iso.slice(0, 12)
  const ms = (m[4] ?? "000").slice(0, 3).padEnd(3, "0")
  return `${m[1]}:${m[2]}:${m[3]}.${ms}`
}

/** Short turn label. `turn_id` in v3 sessions is opaque; we render the SUFFIX
 *  if numeric / short, otherwise the first 4 chars. The hellgate fixtures use
 *  small integer turn ids ("1", "2", "3") so the suffix path is the common
 *  case. */
const fmtTurn = (turnId: string): string => {
  if (turnId.length <= 4) return `t${turnId}`
  // Numeric tail (e.g. "abc-42") ⇒ show the tail.
  const tail = turnId.match(/(\d+)$/)
  if (tail !== null) return `t${tail[1]}`
  return `t${turnId.slice(0, 4)}`
}

/* ------------------------------------------------------------------ */
/* secret-shape sanitizer                                              */
/* ------------------------------------------------------------------ */

/** Conservative prefix list — matches the deterministic-prefix tokens
 *  scanned by `@/security/secret-detection`. We don't import that module
 *  (slice-leaf principle for this surface command); the cost is a slightly
 *  smaller catalogue. False-negatives here mean a token is shown verbatim
 *  in the REPLAY view — which is the SAME content already on disk in the
 *  user's JSONL log, so the leak surface is null. */
const SECRET_PREFIXES = ["sk-", "sk_", "ghp_", "github_pat_", "pat-", "Bearer ", "AKIA"] as const

const looksSecret = (s: string): boolean => {
  for (const p of SECRET_PREFIXES) if (s.startsWith(p)) return true
  return false
}

/** Render a tool input record (free-form `Record<string, unknown>`) into a
 *  compact one-line summary. Two roles:
 *   1. Cap total length at ~60 chars.
 *   2. If any field's string value looks like a secret token, emit
 *      `<key>=<len>B` instead of the value verbatim.
 *  Non-string values are stringified via `JSON.stringify` to keep arrays /
 *  numbers / booleans visible while still respecting the cap.
 */
const fmtToolInput = (input: Record<string, unknown>): string => {
  const keys = Object.keys(input).sort()
  if (keys.length === 0) return "(no args)"
  const parts: string[] = []
  for (const k of keys) {
    const v = input[k]
    if (typeof v === "string") {
      if (looksSecret(v)) {
        parts.push(`${k}=${v.length}B`)
      } else {
        parts.push(`${k}=${trunc(v, 24)}`)
      }
    } else {
      parts.push(`${k}=${trunc(JSON.stringify(v), 24)}`)
    }
  }
  const joined = parts.join(" ")
  return trunc(joined, 60)
}

/* ------------------------------------------------------------------ */
/* per-event-kind renderers                                            */
/* ------------------------------------------------------------------ */

/** Render `tool_invoke` as a `tool_call` line. The envelope schema names the
 *  start-of-tool record `tool_invoke`; the user-visible label is `tool_call`
 *  to keep parity with debug-tracer's vocabulary. */
const renderToolInvoke = (
  e: EventMsgRecord & { kind: "tool_invoke" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.cyan, "tool_call".padEnd(12))
  const tool = c(color, ANSI.bold, e.tool)
  const input = fmtToolInput(e.input)
  const idStr = typeof e.input.toolCallId === "string" ? `id=${e.input.toolCallId}` : ""
  const idCol = c(color, ANSI.dim, idStr)
  return `${fmtTs(e.ts)} [${turn}] ${label} ${tool}(${input})${idStr ? `  ${idCol}` : ""}`
}

const renderToolResult = (
  e: EventMsgRecord & { kind: "tool_result" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.cyan, "tool_result".padEnd(12))
  const okStr = e.ok ? c(color, ANSI.green, "ok=true") : c(color, ANSI.red, "ok=false")
  const size = `${e.output.length}B`
  return `${fmtTs(e.ts)} [${turn}] ${label} ${okStr} ${size} (${trunc(e.tool, 20)})`
}

const renderTokenCount = (
  e: EventMsgRecord & { kind: "token_count" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.magenta, "usage".padEnd(12))
  return `${fmtTs(e.ts)} [${turn}] ${label} in=${e.input_tokens} out=${e.output_tokens}`
}

const renderTaskStarted = (
  e: EventMsgRecord & { kind: "task_started" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.yellow, "task_started".padEnd(12))
  return `${fmtTs(e.ts)} [${turn}] ${label} ${trunc(e.task, 60)}`
}

const renderUserMessage = (
  e: EventMsgRecord & { kind: "user_message" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.yellow, "user_message".padEnd(12))
  return `${fmtTs(e.ts)} [${turn}] ${label} ${trunc(e.content, 80)}`
}

const renderTurnAborted = (
  e: EventMsgRecord & { kind: "turn_aborted" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  const label = c(color, ANSI.red, "turn_aborted".padEnd(12))
  return `${fmtTs(e.ts)} [${turn}] ${label} ${trunc(e.reason, 80)}`
}

/** Custom (escape-hatch) events. We render `kind/custom_kind` so the surface
 *  reads as `[t1] custom        decision allow tc_7a` for a `decision`
 *  custom event with `data.outcome="allow"` etc. The data shape is free-form
 *  so we render alphabetically-sorted scalar fields, capped. */
const renderCustom = (
  e: EventMsgRecord & { kind: "custom" },
  color: boolean | undefined,
): string => {
  const turn = c(color, ANSI.dim, fmtTurn(e.turn_id).padEnd(4))
  // Label = the custom_kind itself (so a `decision` custom event reads as
  // a `decision` row in the table, matching the user-visible spec).
  const label = c(color, ANSI.cyan, trunc(e.custom_kind, 12).padEnd(12))
  const keys = Object.keys(e.data).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = e.data[k]
    const rendered = typeof v === "string" ? trunc(v, 40) : trunc(JSON.stringify(v), 40)
    parts.push(`${k}=${rendered}`)
  }
  // Reason field can be very long — collapse to its own column with a hard
  // cap. Already inside `trunc(v, 40)` per-value but we also cap the joined
  // line at 120 chars to keep rows scannable.
  const tail = trunc(parts.join(" "), 120)
  return `${fmtTs(e.ts)} [${turn}] ${label} ${tail}`
}

/* ------------------------------------------------------------------ */
/* public single-event formatter                                       */
/* ------------------------------------------------------------------ */

/** Format a single envelope record into a one-line string (no trailing `\n`).
 *  The cmd appends `\n` itself when writing through `out`. Unknown shapes
 *  (a `response_item`, a `session_meta`, a `thread_spawn`, or an unknown
 *  `kind`) fall back to a generic `<type|kind> ...` line — never crashes. */
export const formatReplayLine = (
  envelope: SessionEnvelopeRecord,
  opts: { readonly color?: boolean | undefined },
): string => {
  const color = opts.color
  if (envelope.type === "event_msg") {
    switch (envelope.kind) {
      case "tool_invoke":
        return renderToolInvoke(envelope, color)
      case "tool_result":
        return renderToolResult(envelope, color)
      case "token_count":
        return renderTokenCount(envelope, color)
      case "task_started":
        return renderTaskStarted(envelope, color)
      case "user_message":
        return renderUserMessage(envelope, color)
      case "turn_aborted":
        return renderTurnAborted(envelope, color)
      case "custom":
        return renderCustom(envelope, color)
    }
  }
  // Fallback for non-event records (session_meta / turn_context /
  // response_item / thread_spawn) — kept terse, never crashes.
  if (envelope.type === "session_meta") {
    return `(session_meta sid=${trunc(envelope.session_id, 16)} model=${envelope.model})`
  }
  if (envelope.type === "turn_context") {
    return `── turn_context t${envelope.turn_id} model=${envelope.model} ──`
  }
  if (envelope.type === "thread_spawn") {
    return `(thread_spawn parent=${trunc(envelope.parent_session_id, 12)} child=${trunc(
      envelope.child_session_id,
      12,
    )})`
  }
  if (envelope.type === "response_item") {
    return `[t${envelope.turn_id}] ${envelope.item_kind} #${envelope.index}`
  }
  // exhaustiveness — unreachable under the discriminated-union but the
  // TS compiler can prove this via the schema variant list.
  return `(unknown envelope)`
}

/* ------------------------------------------------------------------ */
/* filter logic                                                        */
/* ------------------------------------------------------------------ */

/** Predicate: does a given envelope belong in the rendered stream?
 *
 *  - `atTurn` filters event_msg + response_item records by `turn_id` (numeric
 *    compare against the suffix integer when present, else exact string).
 *  - `fromToolCallId` is a STATE machine — once we see a `tool_invoke` whose
 *    `input.toolCallId === <id>` we flip the gate open for the remainder of
 *    the stream. Records BEFORE the gate are skipped.
 */
interface FilterState {
  atTurn: number | undefined
  fromToolCallId: string | undefined
  gateOpen: boolean
}

const turnMatches = (turnId: string, atTurn: number): boolean => {
  if (turnId === String(atTurn)) return true
  const m = turnId.match(/(\d+)$/)
  if (m === null) return false
  return Number(m[1]) === atTurn
}

const recordTurnId = (env: SessionEnvelopeRecord): string | undefined => {
  if (env.type === "event_msg" || env.type === "response_item" || env.type === "turn_context") {
    return env.turn_id
  }
  return undefined
}

const advanceGate = (env: SessionEnvelopeRecord, state: FilterState): void => {
  if (state.gateOpen || state.fromToolCallId === undefined) return
  if (env.type !== "event_msg" || env.kind !== "tool_invoke") return
  const tcid = env.input.toolCallId
  if (typeof tcid === "string" && tcid === state.fromToolCallId) {
    state.gateOpen = true
  }
}

const passesFilter = (env: SessionEnvelopeRecord, state: FilterState): boolean => {
  if (state.atTurn !== undefined) {
    const tid = recordTurnId(env)
    if (tid === undefined) return false
    if (!turnMatches(tid, state.atTurn)) return false
  }
  advanceGate(env, state)
  if (state.fromToolCallId !== undefined && !state.gateOpen) return false
  return true
}

/* ------------------------------------------------------------------ */
/* runReplayCmd                                                        */
/* ------------------------------------------------------------------ */

/** Render the leading `── replay session <id> · turn N · from TCID ──`
 *  header line. Extracted so `runReplayCmd` stays under biome's cog cap. */
const renderHeader = (sessionId: string, opts: ReplayCmdOpts): string => {
  const color = opts.color
  const turnLabel = opts.filter?.atTurn !== undefined ? ` · turn ${opts.filter.atTurn}` : ""
  const fromLabel =
    opts.filter?.fromToolCallId !== undefined ? ` · from ${opts.filter.fromToolCallId}` : ""
  return `${c(color, ANSI.dim, "── replay session")} ${c(color, ANSI.bold, sessionId)}${turnLabel}${fromLabel} ${c(color, ANSI.dim, "──")}\n\n`
}

/** Classify and emit the zero-frame outcome line (no envelopes passed the
 *  filter). Three sub-shapes: turn-not-found, tool-call-not-found, empty. */
const emitZeroFrameResult = (state: FilterState, opts: ReplayCmdOpts): ReplayCmdResult => {
  const color = opts.color
  if (state.atTurn !== undefined && opts.filter?.fromToolCallId === undefined) {
    opts.out(`\n${c(color, ANSI.dim, `── turn ${state.atTurn} not found ──`)}\n`)
    return { exitCode: 1, framesRendered: 0, message: "turn_not_found" }
  }
  if (state.fromToolCallId !== undefined && !state.gateOpen) {
    opts.out(`\n${c(color, ANSI.dim, `── tool call ${state.fromToolCallId} not found ──`)}\n`)
    return { exitCode: 1, framesRendered: 0, message: "tool_call_not_found" }
  }
  opts.out(`\n${c(color, ANSI.dim, "── session is empty ──")}\n`)
  return { exitCode: 0, framesRendered: 0, message: "empty" }
}

/** One-pass render of the JSONL stream — applies the filter, paces frames,
 *  writes each line, returns the rendered count. Extracted so
 *  `runReplayCmd`'s outer control flow reads as a pure composition. */
const renderStream = async (
  path: string,
  state: FilterState,
  opts: ReplayCmdOpts,
): Promise<number> => {
  const color = opts.color
  const now = opts.now ?? Date.now
  const pace = opts.pace
  let rendered = 0
  let lastFrameAt: number | undefined
  for await (const env of opts.iterate(path)) {
    if (!passesFilter(env, state)) continue
    if (pace !== undefined && pace.intervalMs > 0 && lastFrameAt !== undefined) {
      await pace.sleep(pace.intervalMs)
    }
    opts.out(`${formatReplayLine(env, { color })}\n`)
    rendered += 1
    lastFrameAt = now()
  }
  return rendered
}

/** Resolve a session id → JSONL path; iterate; format; write. Pure
 *  composition over the injected ports — no IO of our own. */
export const runReplayCmd = async (
  sessionId: string,
  opts: ReplayCmdOpts,
): Promise<ReplayCmdResult> => {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const path = await opts.resolveSession(sessionId)
  if (path === undefined) {
    opts.out(`session ${sessionId} not found\n`)
    return { exitCode: 1, framesRendered: 0, message: "not_found" }
  }
  const state: FilterState = {
    atTurn: opts.filter?.atTurn,
    fromToolCallId: opts.filter?.fromToolCallId,
    gateOpen: opts.filter?.fromToolCallId === undefined,
  }
  opts.out(renderHeader(sessionId, opts))
  const rendered = await renderStream(path, state, opts)
  if (rendered === 0) return emitZeroFrameResult(state, opts)
  const wall = ((now() - startedAt) / 1000).toFixed(1)
  opts.out(
    `\n${c(opts.color, ANSI.dim, `── replay done · ${rendered} frame${rendered === 1 ? "" : "s"} · ${wall}s wall ──`)}\n`,
  )
  return { exitCode: 0, framesRendered: rendered }
}

/* ------------------------------------------------------------------ */
/* SlashCommand entry                                                  */
/* ------------------------------------------------------------------ */

import type { SlashCommand } from "./slash-commands"

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0243 — `/replay <session-id>` surface. Resolver + iterator are
     *  injected by the REPL composer (a future Tauri surface or shell
     *  surface can wire its own pair). Absent ⇒ "not wired in this
     *  surface" + exit 0 (parity with the other surface-only commands). */
    readonly replay?:
      | {
          readonly resolveSession: (id: string) => Promise<string | undefined>
          readonly iterate: (path: string) => AsyncIterable<SessionEnvelopeRecord>
        }
      | undefined
  }
}

/** Parse `--at N` / `--from ID` from `args` after the positional session id.
 *  Closed flag set — anything else returns an error string the dispatcher
 *  emits verbatim through `ctx.err`. Reusing yargs / minimist would force a
 *  cross-slice dep; the parser is small enough to keep inline. */
/** Parse `--at <turn>` — returns the integer on success, or an error
 *  message on shape mismatch. Extracted from `parseReplayArgs` to keep its
 *  cog complexity below the biome cap. */
const parseAtFlag = (
  value: string | undefined,
): { ok: true; n: number } | { ok: false; msg: string } => {
  if (value === undefined) return { ok: false, msg: "/replay: --at requires a turn number" }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { ok: false, msg: `/replay: --at expects a non-negative integer; got ${value}` }
  }
  return { ok: true, n }
}

/** Parse `--from <tcid>` — returns the id on success, or an error message. */
const parseFromFlag = (
  value: string | undefined,
): { ok: true; id: string } | { ok: false; msg: string } => {
  if (value === undefined || value === "") {
    return { ok: false, msg: "/replay: --from requires a non-empty tool call id" }
  }
  return { ok: true, id: value }
}

type ParseResult =
  | { kind: "ok"; sessionId: string; filter: { atTurn?: number; fromToolCallId?: string } }
  | { kind: "err"; message: string }

/** Audit finding (HELL-REPLAY-PARSE-07): the first positional must be a
 *  sessionId, never a flag. Without this guard a stray `--bogus` flows down
 *  as `sessionId="--bogus"` and dies later with the misleading "session not
 *  found". We split the two sub-shapes so the error reads honestly:
 *    `/replay --bogus`        → unknown flag '--bogus'
 *    `/replay --at 3 sid`     → expected <session-id> before flags
 *  Returns `undefined` ⇒ head is a legitimate positional sessionId. */
const rejectFlagHead = (head: string): { kind: "err"; message: string } | undefined => {
  if (!head.startsWith("--")) return undefined
  if (head === "--at" || head === "--from") {
    return { kind: "err", message: "/replay: expected <session-id> before flags" }
  }
  return { kind: "err", message: `/replay: unknown flag '${head}'` }
}

const parseReplayArgs = (args: readonly string[]): ParseResult => {
  if (args.length === 0) {
    return { kind: "err", message: "/replay: expected <session-id> [--at <turn>] [--from <tcid>]" }
  }
  const head = args[0] as string
  const headErr = rejectFlagHead(head)
  if (headErr !== undefined) return headErr
  const sessionId = head
  let atTurn: number | undefined
  let fromToolCallId: string | undefined
  let i = 1
  while (i < args.length) {
    const tok = args[i] as string
    if (tok === "--at") {
      const r = parseAtFlag(args[i + 1])
      if (!r.ok) return { kind: "err", message: r.msg }
      atTurn = r.n
      i += 2
      continue
    }
    if (tok === "--from") {
      const r = parseFromFlag(args[i + 1])
      if (!r.ok) return { kind: "err", message: r.msg }
      fromToolCallId = r.id
      i += 2
      continue
    }
    return { kind: "err", message: `/replay: unknown flag '${tok}'` }
  }
  const filter: { atTurn?: number; fromToolCallId?: string } = {}
  if (atTurn !== undefined) filter.atTurn = atTurn
  if (fromToolCallId !== undefined) filter.fromToolCallId = fromToolCallId
  return { kind: "ok", sessionId, filter }
}

export const replayCmd: SlashCommand = {
  name: "/replay",
  describe: "Replay a recorded session JSONL log (read-only, no LLM call)",
  category: "history",
  async run(args, ctx) {
    if (ctx.replay === undefined) {
      ctx.out("/replay: not wired in this surface\n")
      return 0
    }
    const parsed = parseReplayArgs(args)
    if (parsed.kind === "err") {
      ctx.err(`${parsed.message}\n`)
      return 1
    }
    const filter: { atTurn?: number; fromToolCallId?: string } | undefined =
      parsed.filter.atTurn !== undefined || parsed.filter.fromToolCallId !== undefined
        ? parsed.filter
        : undefined
    const result = await runReplayCmd(parsed.sessionId, {
      resolveSession: ctx.replay.resolveSession,
      iterate: ctx.replay.iterate,
      out: ctx.out,
      ...(filter !== undefined ? { filter } : {}),
    })
    return result.exitCode
  },
}

/** Internal helpers — re-exported under a `__test` namespace exclusively for
 *  the hellgate. Keeps the public surface tight (only `runReplayCmd`,
 *  `formatReplayLine`, `replayCmd`, the two opt types) while leaving the
 *  parser + filter logic unit-testable from outside. */
export const __test = {
  parseReplayArgs,
  passesFilter,
  fmtToolInput,
  turnMatches,
} as const
