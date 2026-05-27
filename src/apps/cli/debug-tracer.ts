/**
 * debug-tracer — single-line pretty-printer for AgentEvent → stderr.
 *
 * Track C of the developer-mode slice. A consumer-only adapter: the loop
 * already publishes every `AgentEvent` variant (tool_call / tool_result /
 * llm_request / usage / recovery / plan_* / turn_diff_updated / … + the
 * Track-A `decision` variant) — this module turns each one into a 1-line
 * line on stderr so a developer can watch the trajectory live.
 *
 * Format (HH:MM:SS.mmm wall-clock + relative ms + `[tN]` + 12-char kind +
 * details):
 *
 *   14:23:01.234 [t3] tool_call    Read(src/foo.ts)         id=tc_7a
 *   14:23:01.456 [t3] decision     permission=allow         "default-allow"  tc_7a
 *   14:23:01.512 [t3] tool_result  ok=true 1.2KB 23ms       id=tc_7a
 *
 * Slice-fence: only @/stream types are imported (read-only). Wiring belongs
 * to Track D (session-setup / repl / status-bar); this module is a pure
 * function factory + parseDebugEnv helper.
 *
 * Sanitization: tool input/output are NEVER dumped in full — only a short
 * shape summary (`name`, byte-size, durationMs). `metadata` from the
 * decision variant is stringified with a hard 100-char truncation and a
 * try/catch fallback so circular refs cannot crash the tracer.
 */

import type { AgentEvent } from "@/stream/types"

// ─── public surface ───────────────────────────────────────────────────────

export type DebugCategory = "tools" | "decisions" | "llm" | "memory" | "plan" | "stream" | "other"

export interface DebugTracerOptions {
  /** Restrict output to these categories. `undefined` ⇒ all categories. */
  categories?: ReadonlySet<DebugCategory>
  /** Clock for the wall-clock + relative-ms columns. Default `Date.now`. */
  now?: () => number
  /** stderr replacement sink (tests inject a buffer). Default writes to
   *  `process.stderr` so the CLI doesn't pollute stdout. */
  write?: (chunk: string) => void
  /** Emit ANSI colour escapes when true. Defaults to `process.stderr.isTTY`
   *  read at construction time. */
  color?: boolean
  /** Session-start clock reading — when present, each line carries a
   *  `+1234ms` relative offset suffix so the developer can see cadence. */
  startedAt?: number
}

export type DebugTracer = (event: AgentEvent) => void

// ─── ANSI palette (default OFF when sink is not a TTY) ────────────────────

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
} as const

// ─── factory ──────────────────────────────────────────────────────────────

export const createDebugTracer = (opts: DebugTracerOptions = {}): DebugTracer => {
  const now = opts.now ?? Date.now
  const write = opts.write ?? ((chunk: string) => void process.stderr.write(chunk))
  // Read isTTY once at construction so tests with an injected `write` get
  // deterministic non-coloured output unless they opt in.
  const color = opts.color ?? Boolean(opts.write === undefined && process.stderr.isTTY)
  const cats = opts.categories
  const startedAt = opts.startedAt

  return (event: AgentEvent): void => {
    try {
      const cat = categorize(event)
      if (cats && !cats.has(cat)) return

      const ts = formatClock(now())
      const rel = typeof startedAt === "number" ? `  +${Math.max(0, now() - startedAt)}ms` : ""
      const turn = `[t${clampTurn(extractTurn(event))}]`
      const kindCol = padRight(event.type, 12)
      const detail = formatDetail(event)
      const line = paint(`${ts} ${turn} ${kindCol} ${detail}${rel}`, cat, color)

      write(`${line}\n`)
    } catch {
      // Last-resort fallback: a crash in the tracer must never bring down
      // the surface. Emit a best-effort marker line and swallow.
      try {
        write(`${formatClock(now())} [t?] debug_error <tracer raised>\n`)
      } catch {
        // Sink itself blew up — give up silently.
      }
    }
  }
}

// ─── env helper ───────────────────────────────────────────────────────────

const KNOWN_CATEGORIES: ReadonlySet<DebugCategory> = new Set<DebugCategory>([
  "tools",
  "decisions",
  "llm",
  "memory",
  "plan",
  "stream",
  "other",
])

const FALSY = new Set(["0", "false", "off", "no", ""])

export const parseDebugEnv = (
  raw: string | undefined,
): { enabled: boolean; categories?: ReadonlySet<DebugCategory> } => {
  if (raw === undefined) return { enabled: false }
  const trimmed = raw.trim().toLowerCase()
  if (FALSY.has(trimmed)) return { enabled: false }
  if (trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "all") {
    return { enabled: true }
  }
  // Comma-separated category list; unknowns are silently dropped (no
  // diagnostic — we must not pollute stderr from the parser itself).
  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const valid: DebugCategory[] = []
  for (const t of tokens) {
    if (KNOWN_CATEGORIES.has(t as DebugCategory)) valid.push(t as DebugCategory)
  }
  if (valid.length === 0) return { enabled: false }
  return { enabled: true, categories: new Set(valid) }
}

// ─── helpers (kept small + below complexity-15) ───────────────────────────

const categorize = (event: AgentEvent): DebugCategory => {
  const t = event.type
  if (t === "tool_call" || t === "tool_result" || t === "tool_progress") return "tools"
  if (t === "decision") return "decisions"
  if (
    t === "llm_request" ||
    t === "llm_continuation" ||
    t === "usage" ||
    t === "assistant_text" ||
    t === "in_progress"
  ) {
    return "llm"
  }
  if (t.startsWith("memory_")) return "memory"
  if (t.startsWith("plan_")) return "plan"
  if (t === "recovery" || t === "turn_diff_updated" || t.startsWith("turn_")) return "stream"
  return "other"
}

const extractTurn = (event: AgentEvent): number => {
  const v = event as { turn?: unknown }
  if (typeof v.turn === "number" && Number.isFinite(v.turn)) return v.turn
  return 0
}

const clampTurn = (n: number): number => {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

const formatClock = (ms: number): string => {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const mss = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${mss}`
}

const padRight = (s: string, w: number): string =>
  s.length >= w ? s : s + " ".repeat(w - s.length)

const TRUNC = 100

const truncate = (s: string, max: number = TRUNC): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`

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

const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "?"
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

const inputShapeSummary = (input: unknown): string => {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return truncate(input.replace(/\s+/g, " "), 40)
  if (typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>)
    if (keys.length === 0) return ""
    const head = keys[0]
    const headVal = (input as Record<string, unknown>)[head as string]
    if (typeof headVal === "string") return `${head}=${truncate(headVal, 30)}`
    return truncate(keys.join(","), 40)
  }
  return truncate(String(input), 40)
}

// Per-variant detail builder. Each branch produces a short, sanitized line —
// never dumps full tool input / tool output.
const formatDetail = (e: AgentEvent): string => {
  switch (e.type) {
    case "tool_call":
      return `${e.name}(${inputShapeSummary(e.input)})         id=${e.id}`
    case "tool_result": {
      const sz = fmtBytes(e.preview ? Buffer.byteLength(e.preview, "utf8") : 0)
      const dur = typeof e.durationMs === "number" ? `${e.durationMs}ms` : "?"
      return `ok=${e.ok} ${sz} ${dur}       id=${e.id}`
    }
    case "tool_progress":
      return `${e.name}        ${truncate(e.message, 60)}  id=${e.id}`
    case "decision":
      return formatDecision(e)
    case "llm_request":
      return `model=${e.model}${e.provider ? ` provider=${e.provider}` : ""}`
    case "llm_continuation":
      return `${e.mode} ${e.phase} ${e.reason}${e.statusCode !== undefined ? ` status=${e.statusCode}` : ""}`
    case "usage": {
      const cache = typeof e.cacheReadTokens === "number" ? ` cache=${e.cacheReadTokens}` : ""
      return `in=${e.inputTokens} out=${e.outputTokens}${cache}`
    }
    case "recovery":
      return `${e.reason}${e.detail ? `  "${truncate(e.detail, 60)}"` : ""}`
    case "turn_start":
      return `turn=${e.turn}`
    case "turn_diff_updated":
      return `files=${e.filesChanged} +${e.insertions}/-${e.deletions}`
    case "done":
      return `${e.reason} turns=${e.turns}`
    case "error":
      return truncate(e.message, 80)
    case "assistant_text":
      return `delta=${fmtBytes(Buffer.byteLength(e.delta, "utf8"))}`
    case "plan_created":
    case "plan_snapshot":
      return `plan=${e.plan.id} v${e.plan.version} todos=${e.plan.todos.length}`
    case "plan_updated":
      return `kind=${e.delta.kind} v${e.version}`
    case "mode_changed":
      return `${e.from}→${e.to}`
    case "response_queued":
      return `reason=${e.reason}`
    case "interrupted":
      return `source=${e.source}`
    case "subagent_cancel":
      return `id=${e.subagentId} outcome=${e.outcome}`
    case "context_compacted":
      return `range=${e.fromTurnId}..${e.toTurnId} tokens=${e.tokens}`
    case "in_progress":
      return typeof e.progress === "number" ? `progress=${e.progress}` : "thinking"
    case "session_start":
      return "session begin"
    default:
      return fallbackDetail(e)
  }
}

const formatDecision = (e: AgentEvent & { type: "decision" }): string => {
  const reason = `"${truncate(e.reason, 80)}"`
  const tc = e.toolCallId ? `  ${e.toolCallId}` : ""
  const rid = e.ruleId ? `  rule=${e.ruleId}` : ""
  const hn = e.hookName ? `  hook=${e.hookName}` : ""
  const md = e.metadata ? `  md=${truncate(safeStringify(e.metadata), 80)}` : ""
  return `${e.kind}=${e.outcome}         ${reason}${tc}${rid}${hn}${md}`
}

// Fallback for any event variant the tracer doesn't know about (forward
// compatibility — new AgentEvent variants must not crash this consumer).
const fallbackDetail = (e: AgentEvent): string => {
  const obj = e as Record<string, unknown>
  const interesting: string[] = []
  for (const k of Object.keys(obj)) {
    if (k === "type") continue
    const v = obj[k]
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      interesting.push(`${k}=${truncate(String(v), 30)}`)
    }
    if (interesting.length >= 3) break
  }
  return interesting.join(" ")
}

// Paint a line with a category-specific colour. When `color` is false the
// raw string passes through unchanged (no ANSI escapes anywhere).
const paint = (line: string, cat: DebugCategory, color: boolean): string => {
  if (!color) return line
  switch (cat) {
    case "tools":
      return `${ANSI.cyan}${line}${ANSI.reset}`
    case "decisions":
      return `${ANSI.yellow}${line}${ANSI.reset}`
    case "llm":
      return `${ANSI.magenta}${line}${ANSI.reset}`
    case "memory":
      return `${ANSI.blue}${line}${ANSI.reset}`
    case "plan":
      return `${ANSI.green}${line}${ANSI.reset}`
    case "stream":
      return `${ANSI.dim}${line}${ANSI.reset}`
    default:
      return line
  }
}
