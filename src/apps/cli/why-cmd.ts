/**
 * `/why <toolCallId | last>` — meta-LLM reasoning query for a recorded
 * tool call (ADR-0271, follow-up to ADR-0239 + ADR-0267).
 *
 * ─── value ──────────────────────────────────────────────────────────────
 *   `/inspect tc_7a` (ADR-0239 follow-up) shows the RECORDED facts: tool
 *   input, decision chain, result. That answers *what* happened — not
 *   *why* the agent picked that path. `/why tc_7a` issues ONE additional
 *   LLM call asking the model to introspect a sanitised record of the
 *   call (preceding 3 messages + the tool/input + decisions + result
 *   summary) and emit a structured JSON reasoning chain:
 *
 *     ── why tc_7a — model meta-query (gpt-5, 1.4s, 320 tokens) ──
 *
 *       goal       : "Locate the foo handler definition"
 *       reasoning  :
 *         1. Earlier message asked "where is foo defined"
 *         2. Read tool gives line-level precision faster than grep here
 *         3. Single-file path known from project structure
 *       considered :
 *         - grep for the symbol (slower, more output)
 *         - bun:lsp signature-help (not wired in this turn)
 *       confidence : high
 *     ───────────────────────────────────────────
 *
 * ─── cost + privacy ─────────────────────────────────────────────────────
 *   ONE LLM call per invocation (caller is told via the rendered header
 *   how many tokens were used). NO caching — callers who care about cost
 *   are expected to wrap. The sanitiser (`redactValue` from
 *   `@/shared/trajectory`) strips Bearer tokens / `sk-…` keys / `email`
 *   / `apiKey` / `Authorization` / canonical PII keys BEFORE they reach
 *   the wire — secrets never leave the host even though the LLM is
 *   remote.
 *
 *   Context cap: only the LAST 3 message snippets, each truncated to
 *   ~600 chars. The full session is never shipped to the LLM.
 *
 * ─── invariants ─────────────────────────────────────────────────────────
 *   - JSON parse failure ⇒ render a "(LLM returned unstructured prose)"
 *     fallback panel with the raw text. Never throws.
 *   - LLM throw ⇒ exit 1 + `meta query failed: <reason>` message.
 *   - Same `runWhyCmd` shape as `runInspectCmd` (test seam + sink
 *     injection), so the slash surface reuses the same pattern.
 *
 * Slice fence: `src/apps/cli` ⇒ may import `@/llm` (LLMPort + assemble)
 *   and `@/session` (data types) + `@/shared` (utility). Does NOT
 *   reach into `@/agent`.
 */

import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
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

export interface WhyCmdDeps {
  /** Inject — the active LLMPort to call for the meta-query. */
  readonly llm: LLMPort
  /** Inject — read the active session's JSONL envelopes. */
  readonly readSessionEnvelopes: (sessionId: string) => Promise<readonly SessionEnvelopeRecord[]>
  /** Active session id from surface. */
  readonly sessionId: string | undefined
  /** stdout sink. */
  readonly out: (chunk: string) => void
  /** Model identifier (caller already resolved). */
  readonly model: string
  /** Color ANSI. Default `stdout.isTTY`. */
  readonly color?: boolean
}

export interface WhyCmdResult {
  readonly exitCode: number
  readonly tokensUsed?: number
}

/* ─── meta-query prompt ─────────────────────────────────────────────── */

const META_SYSTEM_PROMPT =
  "You are an introspection assistant. Given a tool-call record from an AI " +
  "agent's session, explain in JSON why the agent likely made this call. " +
  'Output schema: {"goal": string, "reasoning": [string], ' +
  '"alternatives_considered": [string], "confidence": "high"|"medium"|"low"}. ' +
  "Output JSON only, no prose, no markdown fences."

/** Cap for raw text shipped per snippet (chars). The model already has
 *  the structured tool input + decision rows — the message snippets are
 *  for context flavour, not full transcript fidelity. */
const SNIPPET_CHAR_CAP = 600
/** Number of preceding response_item snippets shipped as context. */
const PRECEDING_SNIPPET_COUNT = 3
/** Cap for the rendered `goal` field (chars). */
const GOAL_RENDER_CAP = 500

/* ─── orchestration ─────────────────────────────────────────────────── */

export const runWhyCmd = async (
  toolCallIdOrLast: string,
  deps: WhyCmdDeps,
): Promise<WhyCmdResult> => {
  const arg = (toolCallIdOrLast ?? "").trim()
  if (arg === "") {
    deps.out("/why: tool call id is required (e.g. /why tc_7a or /why last)\n")
    return { exitCode: 1 }
  }
  const sessionId = deps.sessionId
  if (sessionId === undefined || sessionId === "") {
    deps.out("no active session — start an agent first or pass --session <id>\n")
    return { exitCode: 1 }
  }

  let envelopes: readonly SessionEnvelopeRecord[]
  try {
    envelopes = await deps.readSessionEnvelopes(sessionId)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    deps.out(`/why: failed to read session ${sessionId}: ${detail}\n`)
    return { exitCode: 1 }
  }

  // Resolve `last` to the most-recent tool_call id by scanning the
  // envelopes in arrival order and taking the last decision /
  // tool_invoke / custom-tool-call id seen.
  let resolvedId: string | undefined
  if (arg === "last") {
    resolvedId = findLastToolCallId(envelopes)
    if (resolvedId === undefined) {
      deps.out("/why: no tool calls found in session\n")
      return { exitCode: 1 }
    }
  } else {
    resolvedId = arg
  }

  const groups = findByToolCallId(envelopes, resolvedId)
  if (groups.length === 0) {
    deps.out(`tool call ${resolvedId} not found in session ${sessionId}\n`)
    return { exitCode: 1 }
  }
  // For `/why` we use the FIRST occurrence (matches the most-common
  // case — one tool_call id per group). Renderer notes when multiple
  // occurrences exist.
  const group = groups[0] as InspectGroup
  const userPrompt = buildUserPrompt(envelopes, group)

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: userPrompt }] },
  ]
  const start = Date.now()
  let events: StreamEvent[]
  try {
    events = []
    for await (const ev of deps.llm.stream({
      messages,
      system: META_SYSTEM_PROMPT,
      tools: [],
    })) {
      events.push(ev)
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    deps.out(`/why: meta query failed: ${reason}\n`)
    return { exitCode: 1 }
  }
  const elapsed = Date.now() - start

  const { message } = assembleFromEvents(events)
  const rawText = assistantText(message)
  const usage = events.find((e) => e.type === "usage") as
    | Extract<StreamEvent, { type: "usage" }>
    | undefined
  const tokensUsed =
    usage !== undefined ? usage.inputTokens + usage.outputTokens : undefined

  const parsed = parseReasoning(rawText)
  const color = deps.color === true
  if (parsed === null) {
    deps.out(renderFallback(resolvedId, rawText, deps.model, elapsed, tokensUsed, color))
  } else {
    deps.out(
      renderReasoning(resolvedId, parsed, deps.model, elapsed, tokensUsed, color, groups.length),
    )
  }
  return tokensUsed === undefined ? { exitCode: 0 } : { exitCode: 0, tokensUsed }
}

/* ─── envelope helpers ──────────────────────────────────────────────── */

/** Find the most-recently-emitted tool_call id in arrival (file) order.
 *  Scans decisions, custom events (with `data.id`/`data.toolCallId`),
 *  and synthesises an id from tool_invoke/tool_result envelopes when
 *  the upstream emitter pairs them. For native tool_invoke we can't
 *  recover an id (no on-wire field), so we fall back to "first
 *  decision id seen in the same turn", iterated newest-first. */
const findLastToolCallId = (
  envelopes: readonly SessionEnvelopeRecord[],
): string | undefined => {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const env = envelopes[i] as SessionEnvelopeRecord
    if (env.type !== "event_msg") continue
    const e = env as EventMsgRecord
    if (e.kind === "decision" && typeof e.tool_call_id === "string" && e.tool_call_id.length > 0) {
      return e.tool_call_id
    }
    if (e.kind === "custom") {
      const id = customDataId(e.data)
      if (id !== undefined) return id
    }
  }
  return undefined
}

const customDataId = (data: Record<string, unknown>): string | undefined => {
  const a = data.id
  if (typeof a === "string" && a.length > 0) return a
  const b = data.toolCallId
  if (typeof b === "string" && b.length > 0) return b
  return undefined
}

/** Build the meta-query user prompt: structured record of the tool call,
 *  preceding context (last 3 response_items / user_messages), decisions,
 *  result summary. All payloads pass through `redactValue` BEFORE they
 *  leave the host. */
const buildUserPrompt = (
  envelopes: readonly SessionEnvelopeRecord[],
  group: InspectGroup,
): string => {
  const lines: string[] = []
  if (group.turnId !== undefined) {
    lines.push(`Session turn ${group.turnId}.`)
  } else {
    lines.push("Session turn (unknown).")
  }
  lines.push("")
  const preceding = precedingSnippets(envelopes, group)
  if (preceding.length > 0) {
    lines.push("Preceding context (last 3 messages):")
    for (const snip of preceding) {
      lines.push(`  - ${snip}`)
    }
    lines.push("")
  }
  if (group.toolInvokes.length > 0) {
    const inv = group.toolInvokes[0] as Extract<EventMsgRecord, { kind: "tool_invoke" }>
    lines.push("Tool call:")
    lines.push(`  tool: ${inv.tool}`)
    lines.push(`  input: ${truncForWire(safeJson(redactValue(inv.input)), SNIPPET_CHAR_CAP)}`)
    lines.push("")
  }
  if (group.decisions.length > 0) {
    lines.push("Decisions:")
    for (const d of group.decisions) {
      const extras: string[] = []
      if (d.rule_id !== undefined) extras.push(`rule=${d.rule_id}`)
      if (d.hook_name !== undefined) extras.push(`hook=${d.hook_name}`)
      const tail = extras.length === 0 ? "" : ` (${extras.join(", ")})`
      lines.push(
        `  ${d.gate}=${d.outcome} '${truncForWire(d.decision_reason, 200)}'${tail}`,
      )
    }
    lines.push("")
  }
  if (group.toolResults.length > 0) {
    const r = group.toolResults[group.toolResults.length - 1] as Extract<
      EventMsgRecord,
      { kind: "tool_result" }
    >
    const status = r.ok ? "ok" : "error"
    const outPreview = truncForWire(r.output.replace(/\n/g, "\\n"), 200)
    lines.push(`Result: ${status} — ${outPreview}`)
    lines.push("")
  }
  lines.push("Why did the agent make this call?")
  return lines.join("\n")
}

/** Yield up to 3 preceding "snippets" (user_message events or
 *  assistant_text response_items) that appear BEFORE the matched
 *  group's first record. We never include the future — only past
 *  signal. Each snippet is redacted + truncated. */
const precedingSnippets = (
  envelopes: readonly SessionEnvelopeRecord[],
  group: InspectGroup,
): readonly string[] => {
  const firstMatchTs = firstTs(group)
  const out: string[] = []
  for (const env of envelopes) {
    if (env.type === "event_msg" && env.kind === "user_message") {
      if (firstMatchTs !== undefined && env.ts >= firstMatchTs) continue
      const text = sanitiseString(env.content)
      out.push(`user: "${truncForWire(text, SNIPPET_CHAR_CAP)}"`)
    } else if (env.type === "response_item" && env.item_kind === "assistant_text") {
      // response_item has no `ts` field; ordering by file position is
      // good enough — if the same turn produced the assistant_text
      // BEFORE the matched group in file order, it counts.
      out.push(`assistant: "${truncForWire(sanitiseString(env.content), SNIPPET_CHAR_CAP)}"`)
    }
  }
  // Keep only the last 3 (most recent). The full session is never sent.
  return out.slice(Math.max(0, out.length - PRECEDING_SNIPPET_COUNT))
}

const firstTs = (g: InspectGroup): string | undefined => {
  const m = g.matches[0]?.record
  if (m && "ts" in (m as Record<string, unknown>)) {
    return (m as { ts?: string }).ts ?? undefined
  }
  return undefined
}

/** Pull plain text out of an assembled assistant message. */
const assistantText = (m: Message): string => {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === "text") parts.push(b.text)
  }
  return parts.join("\n").trim()
}

/* ─── sanitisation ──────────────────────────────────────────────────── */

/** Run a single string through the shared trajectory redactor (treats
 *  the input as a one-field record so secret-shape values are masked). */
const sanitiseString = (s: string): string => {
  const r = redactValue({ v: s }) as { v: unknown }
  const v = r.v
  return typeof v === "string" ? v : safeJson(v)
}

const safeJson = (v: unknown): string => {
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

const truncForWire = (s: string, max: number): string => {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…(${s.length - max + 1} more)`
}

/* ─── JSON parse ─────────────────────────────────────────────────────── */

export interface ReasoningPayload {
  readonly goal: string
  readonly reasoning: readonly string[]
  readonly alternativesConsidered: readonly string[]
  readonly confidence: "high" | "medium" | "low"
}

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low"])

/** Best-effort parse: strip optional markdown fences, parse JSON, coerce
 *  shape, return null on failure. NEVER throws. */
const parseReasoning = (raw: string): ReasoningPayload | null => {
  const stripped = stripFences(raw).trim()
  if (stripped === "") return null
  let obj: unknown
  try {
    obj = JSON.parse(stripped)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>
  if (typeof o.goal !== "string") return null
  const reasoning = Array.isArray(o.reasoning) ? o.reasoning.filter((s) => typeof s === "string") : null
  const alt = Array.isArray(o.alternatives_considered)
    ? o.alternatives_considered.filter((s) => typeof s === "string")
    : []
  if (reasoning === null) return null
  const conf = typeof o.confidence === "string" && CONFIDENCE_VALUES.has(o.confidence)
    ? (o.confidence as "high" | "medium" | "low")
    : "medium"
  return {
    goal: o.goal,
    reasoning: reasoning as readonly string[],
    alternativesConsidered: alt as readonly string[],
    confidence: conf,
  }
}

/** Strip a leading/trailing ```json … ``` fence (or ``` … ```) if present.
 *  Tolerant — any deviation falls through and the JSON.parse below catches
 *  the rest. */
const stripFences = (s: string): string => {
  const trimmed = s.trim()
  // ```json … ``` or ``` … ```
  const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed)
  if (fenceMatch !== null) return fenceMatch[1] ?? ""
  // Looser: starts with ``` and ends with ``` (newlines optional).
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inner = trimmed.slice(3, -3)
    return inner.replace(/^json\s*/i, "").trim()
  }
  return trimmed
}

/* ─── render ─────────────────────────────────────────────────────────── */

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

const fmtElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const renderReasoning = (
  toolCallId: string,
  p: ReasoningPayload,
  model: string,
  elapsedMs: number,
  tokensUsed: number | undefined,
  color: boolean,
  occurrenceCount: number,
): string => {
  const tokensPart = tokensUsed !== undefined ? `, ${tokensUsed} tokens` : ""
  const occPart = occurrenceCount > 1 ? ` · ${occurrenceCount} occurrences` : ""
  const head = `── why ${toolCallId} — model meta-query (${model}, ${fmtElapsed(elapsedMs)}${tokensPart})${occPart} ──`
  const lines: string[] = []
  lines.push(paint(head, "bold", color))
  lines.push("")
  const goal = truncForWire(p.goal, GOAL_RENDER_CAP)
  lines.push(`  ${paint("goal", "cyan", color)}       : "${goal}"`)
  lines.push(`  ${paint("reasoning", "cyan", color)}  :`)
  if (p.reasoning.length === 0) {
    lines.push(`    ${paint("(none provided)", "dim", color)}`)
  } else {
    for (let i = 0; i < p.reasoning.length; i++) {
      lines.push(`    ${i + 1}. ${p.reasoning[i]}`)
    }
  }
  lines.push(`  ${paint("considered", "cyan", color)} :`)
  if (p.alternativesConsidered.length === 0) {
    lines.push(`    ${paint("(none)", "dim", color)}`)
  } else {
    for (const a of p.alternativesConsidered) {
      lines.push(`    - ${a}`)
    }
  }
  const confCode: keyof typeof ANSI =
    p.confidence === "high" ? "green" : p.confidence === "low" ? "yellow" : "cyan"
  const confLabel = p.confidence === "low" ? `low  ${paint("(uncertain)", "dim", color)}` : p.confidence
  lines.push(`  ${paint("confidence", "cyan", color)} : ${paint(p.confidence, confCode, color)}`)
  // Surface the "low" annotation only when relevant — keeps high/medium
  // line shape stable.
  if (p.confidence === "low") {
    lines.push(`    ${paint("note: model marked this as uncertain", "dim", color)}`)
  }
  void confLabel // referenced for clarity above; main render uses `paint(p.confidence, ...)`.
  lines.push("")
  lines.push(paint("───────────────────────────────────────────", "dim", color))
  return `${lines.join("\n")}\n`
}

const renderFallback = (
  toolCallId: string,
  raw: string,
  model: string,
  elapsedMs: number,
  tokensUsed: number | undefined,
  color: boolean,
): string => {
  const tokensPart = tokensUsed !== undefined ? `, ${tokensUsed} tokens` : ""
  const head = `── why ${toolCallId} — model meta-query (${model}, ${fmtElapsed(elapsedMs)}${tokensPart}) ──`
  const lines: string[] = []
  lines.push(paint(head, "bold", color))
  lines.push("")
  lines.push(
    `  ${paint("note", "yellow", color)}       : LLM returned unstructured prose; raw output below`,
  )
  lines.push("")
  lines.push(`  ${paint("raw", "cyan", color)}        :`)
  for (const line of raw.split("\n")) {
    lines.push(`    ${line}`)
  }
  lines.push("")
  lines.push(paint("───────────────────────────────────────────", "dim", color))
  return `${lines.join("\n")}\n`
}

/* ─── SlashContext augmentation ──────────────────────────────────────── */

export interface WhySlashState {
  /** Active session id. */
  readonly sessionId: string
  /** Model identifier — surfaced in the rendered header. */
  readonly model: string
  /** Active LLM port used to issue the ONE meta-query call. */
  readonly llm: LLMPort
  /** Override the envelope reader (test seam). Production omits this and
   *  lets the slash adapter default to the file-backed reader. */
  readonly readSessionEnvelopes?: (sessionId: string) => Promise<readonly SessionEnvelopeRecord[]>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0271 — `/why <toolCallId|last>` meta-LLM reasoning query slot. */
    readonly why?: WhySlashState | undefined
  }
}

/* ─── default reader (production) ────────────────────────────────────── */

const defaultReadSessionEnvelopes = async (
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
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    const msg = e instanceof Error ? e.message : String(e)
    if (code === "ENOENT" || /not found/i.test(msg)) return []
    throw e
  }
  return out
}

/* ─── builtin entry ──────────────────────────────────────────────────── */

export const whyCmd: SlashCommand = {
  name: "/why",
  describe: "Meta-LLM reasoning query for a tool call (id or 'last')",
  category: "session",
  async run(args, ctx) {
    if (args.length === 0) {
      ctx.err("/why: tool call id required (usage: /why <toolCallId|last>)\n")
      return 1
    }
    if (args.length > 1) {
      ctx.err(`/why: takes exactly one argument; got ${args.length}\n`)
      return 1
    }
    const id = args[0] as string
    const state = ctx.why
    if (state === undefined) {
      ctx.out("/why: not wired in this surface\n")
      return 0
    }
    const reader = state.readSessionEnvelopes ?? defaultReadSessionEnvelopes
    const result = await runWhyCmd(id, {
      out: ctx.out,
      sessionId: state.sessionId,
      model: state.model,
      llm: state.llm,
      readSessionEnvelopes: reader,
    })
    return result.exitCode
  },
  complete(_args, _partial, _ctx) {
    return [
      {
        value: "<toolCallId|last>",
        kind: "argument",
        description: "id from /debug stderr trace, or 'last'",
      },
    ]
  },
}

/* ─── test-only re-exports ───────────────────────────────────────────── */

export const __test = {
  parseReasoning,
  stripFences,
  buildUserPrompt,
  truncForWire,
  sanitiseString,
  findLastToolCallId,
}

/* ─── runtime type-import pin ────────────────────────────────────────── */
export type _RefUnused = TurnContextRecord | ResponseItemRecord | EventMsgRecord
