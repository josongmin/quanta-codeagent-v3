/**
 * `/inspect <toolCallId>` — debug-mode follow-up surface to ADR-0239.
 *
 * `/debug` (ADR-0239) writes a single-line per-event tracer to stderr. Long
 * tool inputs/outputs and rich gate-decision metadata are unreadable when
 * compressed into one line. `/inspect tc_7a` re-reads the session JSONL
 * transcript and renders a multi-section panel for the ONE tool-call with
 * id `tc_7a`:
 *
 *     ── tool call tc_7a ── turn 3 · 1.42s · ok ──
 *
 *       tool       : Read
 *       input      : {"path":"src/foo.ts"}
 *
 *       decisions:
 *         · permission · allow      "default-allow"
 *         · rule       · allow      "no rule match"
 *
 *       result     : 1.2KB · 23ms · 0 errors
 *       preview    : "export const ..."
 *
 *     ───────────────────────────────────────────
 *
 * Layout in one file (mirrors `rewind-tool-cmd.ts`):
 *   - `runInspectCmd` — pure async handler (tested with injected deps);
 *   - `inspectCmd`    — `SlashCommand` entry registered by `BUILTINS`;
 *   - `declare module` augmentation extends `SlashContext.inspect`.
 *
 * Slice fence: `src/apps/cli` ⇒ may import `@/session` (data layer) and
 * `@/shared` (utility) — never reaches into `@/agent` / `@/llm`.
 */

import type {
  EventMsgRecord,
  ResponseItemRecord,
  SessionEnvelopeRecord,
  TurnContextRecord,
} from "@/session"
import { findByToolCallId, type InspectGroup } from "@/session/inspect-source"
import { redactValue } from "@/shared"
import type { SlashCommand } from "./slash-commands"

/* ─── public surface — pure handler ──────────────────────────────────── */

export interface InspectCmdDeps {
  /** Open session JSONL — caller injects (test seam). Production wires the
   *  default surface-resolved active session reader. */
  readonly readSessionJsonl: (sessionId: string) => Promise<readonly SessionEnvelopeRecord[]>
  /** stdout sink — `process.stdout.write` in production, buffer in tests. */
  readonly out: (chunk: string) => void
  /** Active session id (caller provides — `inspect` doesn't pick one). */
  readonly sessionId: string | undefined
  /** Color output. Defaults to `false` (the caller decides — typically
   *  `process.stdout.isTTY` in production). */
  readonly color?: boolean
}

export interface InspectCmdResult {
  readonly exitCode: number
  /** A short status / error line — also written via `out`. Returned so the
   *  caller can log without recomposing the message. */
  readonly message: string
}

export const runInspectCmd = async (
  toolCallId: string,
  deps: InspectCmdDeps,
): Promise<InspectCmdResult> => {
  const id = (toolCallId ?? "").trim()
  if (id === "") {
    const msg = "/inspect: tool call id is required (e.g. /inspect tc_7a)"
    deps.out(`${msg}\n`)
    return { exitCode: 1, message: msg }
  }
  const sessionId = deps.sessionId
  if (sessionId === undefined || sessionId === "") {
    const msg = "no active session — start an agent first or pass --session <id>"
    deps.out(`${msg}\n`)
    return { exitCode: 1, message: msg }
  }

  let envelopes: readonly SessionEnvelopeRecord[]
  try {
    envelopes = await deps.readSessionJsonl(sessionId)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const msg = `/inspect: failed to read session ${sessionId}: ${detail}`
    deps.out(`${msg}\n`)
    return { exitCode: 1, message: msg }
  }

  const groups = findByToolCallId(envelopes, id)
  if (groups.length === 0) {
    const msg = `tool call ${id} not found in session ${sessionId}`
    deps.out(`${msg}\n`)
    return { exitCode: 1, message: msg }
  }

  const color = deps.color === true
  for (let i = 0; i < groups.length; i++) {
    deps.out(renderGroup(groups[i] as InspectGroup, color, i, groups.length))
  }
  return { exitCode: 0, message: `displayed ${groups.length} occurrence(s) of ${id}` }
}

/* ─── render helpers ─────────────────────────────────────────────────── */

/** ANSI escape codepoint — built lazily so a `color=false` build never
 *  embeds the escape byte in the output. */
const ESC = String.fromCharCode(0x1b)
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const

const paint = (s: string, code: keyof typeof ANSI, color: boolean): string =>
  color ? `${ANSI[code]}${s}${ANSI.reset}` : s

/** Truncate a string to `max` chars, marking the truncation. Pure. */
const TRUNCATE_DEFAULT = 200
const trunc = (s: string, max = TRUNCATE_DEFAULT): string => {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…(${s.length - max + 1} more)`
}

/** Compute a duration string between two ISO-8601 timestamps. Returns "?" if
 *  the timestamps don't parse. Pure. */
const fmtDuration = (fromTs: string | undefined, toTs: string | undefined): string => {
  if (!fromTs || !toTs) return "?"
  const a = Date.parse(fromTs)
  const b = Date.parse(toTs)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "?"
  const ms = Math.abs(b - a)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Human-friendly byte-size formatter. Pure. */
const fmtSize = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "?"
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

/** Stringify an unknown payload safely (handles circulars + non-JSONable). */
const safeStringify = (v: unknown): string => {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]"
        seen.add(val)
      }
      return val
    })
  } catch {
    return "<unserializable>"
  }
}

/** Run the shared redactor over a payload then JSON-stringify. Used for
 *  tool input + decision metadata so a key like `Authorization` or a
 *  value like `Bearer …` never reaches stdout verbatim. */
const sanitize = (v: unknown): string => safeStringify(redactValue(v))

/** Render the matched group as a single panel. Pure function; the caller
 *  joins the panel strings before passing them to the sink. */
const renderGroup = (g: InspectGroup, color: boolean, idx: number, total: number): string => {
  const lines: string[] = []
  lines.push(renderHeader(g, color, idx, total))
  lines.push("")
  for (const l of renderToolInputLines(g, color)) lines.push(l)
  for (const l of renderDecisionLines(g, color)) lines.push(l)
  for (const l of renderToolResultLines(g, color)) lines.push(l)
  for (const l of renderCustomLines(g, color)) lines.push(l)
  for (const l of renderResponseItemLines(g, color)) lines.push(l)
  for (const w of g.warnings) {
    lines.push(`  ${paint(`! ${w}`, "yellow", color)}`)
  }
  lines.push("")
  lines.push(paint("───────────────────────────────────────────", "dim", color))
  return `${lines.join("\n")}\n`
}

/** First-record timestamp (display only). */
const firstTs = (g: InspectGroup): string | undefined => {
  const m = g.matches[0]?.record
  if (m && "ts" in (m as Record<string, unknown>)) {
    return (m as { ts?: string }).ts ?? undefined
  }
  return undefined
}

/** Last-record timestamp (for span duration). */
const lastTs = (g: InspectGroup): string | undefined => {
  const last = g.toolResults[g.toolResults.length - 1]
  if (last) return last.ts
  const m = g.matches[g.matches.length - 1]?.record
  if (m && "ts" in (m as Record<string, unknown>)) {
    return (m as { ts?: string }).ts ?? undefined
  }
  return undefined
}

/** ok-status heuristic from the last tool_result envelope. */
const okFromResults = (g: InspectGroup): "ok" | "fail" | "?" => {
  if (g.toolResults.length === 0) return "?"
  const last = g.toolResults[g.toolResults.length - 1] as Extract<
    EventMsgRecord,
    { kind: "tool_result" }
  >
  return last.ok ? "ok" : "fail"
}

const renderHeader = (g: InspectGroup, color: boolean, idx: number, total: number): string => {
  const occ = total > 1 ? ` (occurrence ${idx + 1}/${total})` : ""
  const turnPart = g.turnId !== undefined ? ` turn ${g.turnId}` : ""
  const dur = fmtDuration(firstTs(g), lastTs(g))
  const ok = okFromResults(g)
  const okPainted =
    ok === "ok"
      ? paint("ok", "green", color)
      : ok === "fail"
        ? paint("fail", "red", color)
        : paint("?", "dim", color)
  const head = `── tool call ${g.toolCallId} ──${turnPart} · ${dur} · ${okPainted} ──${occ}`
  return paint(head, "bold", color)
}

const renderToolInputLines = (g: InspectGroup, color: boolean): readonly string[] => {
  if (g.toolInvokes.length === 0) return []
  const lines: string[] = []
  // If multiple tool_invokes co-locate (parallel tools in one turn), show
  // each — the projector already warned on the ambiguity.
  for (const inv of g.toolInvokes) {
    lines.push(`  ${paint("tool", "cyan", color)}       : ${inv.tool}`)
    lines.push(`  ${paint("input", "cyan", color)}      : ${trunc(sanitize(inv.input), 500)}`)
  }
  lines.push("")
  return lines
}

const renderDecisionLines = (g: InspectGroup, color: boolean): readonly string[] => {
  if (g.decisions.length === 0) return []
  const lines: string[] = []
  lines.push(`  ${paint("decisions", "cyan", color)}:`)
  for (const d of g.decisions) {
    const outcomeCol = d.outcome === "allow" ? "green" : d.outcome === "deny" ? "red" : "yellow"
    const outcomeText = paint(d.outcome.padEnd(5), outcomeCol, color)
    const reason = `"${trunc(d.decision_reason, 500)}"`
    const extras: string[] = []
    if (d.rule_id !== undefined) extras.push(`rule=${d.rule_id}`)
    if (d.hook_name !== undefined) extras.push(`hook=${d.hook_name}`)
    if (d.metadata !== undefined) extras.push(`md=${trunc(sanitize(d.metadata), 100)}`)
    const tail = extras.length === 0 ? "" : `  ${extras.join(" ")}`
    lines.push(`    · ${d.gate.padEnd(10)} · ${outcomeText} ${reason}${tail}`)
  }
  lines.push("")
  return lines
}

const renderToolResultLines = (g: InspectGroup, color: boolean): readonly string[] => {
  if (g.toolResults.length === 0) return []
  const lines: string[] = []
  for (const r of g.toolResults) {
    const sz = fmtSize(Buffer.byteLength(r.output, "utf8"))
    const okText = r.ok ? paint("ok", "green", color) : paint("fail", "red", color)
    lines.push(`  ${paint("result", "cyan", color)}     : ${sz} · ${okText} · ${r.tool}`)
    if (r.output.length === 0) {
      lines.push(`  ${paint("preview", "cyan", color)}    : ${paint("(empty)", "dim", color)}`)
    } else {
      const preview = trunc(r.output.replace(/\n/g, "\\n"), 200)
      lines.push(`  ${paint("preview", "cyan", color)}    : "${preview}"`)
    }
  }
  return lines
}

const renderCustomLines = (g: InspectGroup, color: boolean): readonly string[] => {
  if (g.customs.length === 0) return []
  const lines: string[] = []
  for (const c of g.customs) {
    lines.push(
      `  ${paint("event", "cyan", color)}      : ${c.custom_kind} ${trunc(sanitize(c.data), 200)}`,
    )
  }
  return lines
}

const renderResponseItemLines = (g: InspectGroup, color: boolean): readonly string[] => {
  if (g.responseItems.length === 0) return []
  const lines: string[] = []
  lines.push("")
  lines.push(`  ${paint("response", "cyan", color)}   :`)
  for (const ri of g.responseItems) {
    lines.push(`    · ${ri.item_kind}[${ri.index}] ${trunc(ri.content, 120)}`)
  }
  return lines
}

/* ─── SlashContext augmentation ──────────────────────────────────────── */

/** Wiring slot for `/inspect`. The REPL composes this when the surface has
 *  an active session id; one-shot / shell-entry surfaces omit it ⇒ the
 *  slash command prints "no active session — start an agent first or pass
 *  --session <id>" and exits 1 (parity with other surface-only commands
 *  that need a session). */
export interface InspectSlashState {
  /** Active session id. `/inspect` will resolve `<root>/<id>.jsonl` via the
   *  default reader unless the host injects its own `readSessionJsonl`. */
  readonly sessionId: string
  /** Optional override — test seam. Production omits this and lets the
   *  command default to the file-backed reader. */
  readonly readSessionJsonl?: (sessionId: string) => Promise<readonly SessionEnvelopeRecord[]>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0239 follow-up surface wiring slot. */
    readonly inspect?: InspectSlashState | undefined
  }
}

/* ─── default reader (production) ────────────────────────────────────── */

/** Default `readSessionJsonl`: open `<sessionsRoot>/<id>.jsonl`, iterate
 *  every decoded envelope, drop decode errors silently (the panel surfaces
 *  warnings via the projector). A missing file returns `[]` so the caller
 *  sees the "not found" code path uniformly. */
const defaultReadSessionJsonl = async (
  sessionId: string,
): Promise<readonly SessionEnvelopeRecord[]> => {
  const { sessionEnvelopePath, iterateSessionFile } = await import("@/session")
  const path = sessionEnvelopePath(sessionId)
  const out: SessionEnvelopeRecord[] = []
  try {
    for await (const r of iterateSessionFile(path)) {
      if (r.ok) out.push(r.value)
    }
  } catch (e) {
    // ENOENT ⇒ session JSONL never written (the envelope rail is opt-in
    // — many sessions only have the snapshot JSON). Treat as "empty".
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    const msg = e instanceof Error ? e.message : String(e)
    if (code === "ENOENT" || /not found/i.test(msg)) return []
    throw e
  }
  return out
}

/* ─── builtin entry ──────────────────────────────────────────────────── */

export const inspectCmd: SlashCommand = {
  name: "/inspect",
  describe: "Expand a single tool-call by id (input + decisions + result)",
  category: "session",
  async run(args, ctx) {
    if (args.length === 0) {
      ctx.err("/inspect: tool call id required (usage: /inspect <toolCallId>)\n")
      return 1
    }
    if (args.length > 1) {
      ctx.err(`/inspect: takes exactly one argument; got ${args.length}\n`)
      return 1
    }
    const id = args[0] as string
    const state = ctx.inspect
    const sessionId = state?.sessionId
    const reader = state?.readSessionJsonl ?? defaultReadSessionJsonl
    const result = await runInspectCmd(id, {
      out: ctx.out,
      sessionId,
      readSessionJsonl: reader,
    })
    return result.exitCode
  },
  complete(_args, _partial, _ctx) {
    return [
      {
        value: "<toolCallId>",
        kind: "argument",
        description: "id from the /debug stderr trace (e.g. tc_7a)",
      },
    ]
  },
}

/* ─── test-only re-exports ───────────────────────────────────────────── */

export const __test = {
  trunc,
  fmtDuration,
  fmtSize,
  sanitize,
  safeStringify,
  renderGroup,
}

/* ─── runtime type helpers (avoid unused-warnings on inferred narrows) ─ */
// These are intentionally written so a future biome lint pass can SEE the
// type imports are used (some tools mis-detect transitive type usage when
// every reference is through z.infer-ed narrowing).
export type _RefUnused = TurnContextRecord | ResponseItemRecord | EventMsgRecord
