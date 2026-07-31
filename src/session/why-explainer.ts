/**
 * `/why` introspection domain logic (surface-agnostic).
 *
 * The meta-query PROMPT authoring + structured-output PARSING for the `/why`
 * tool-call explainer (ADR-0271). Relocated from `apps/cli/why-cmd.ts` (thin-
 * surface audit): prompt construction (which session signal to ship, how to
 * redact + truncate it) and reply parsing (fence-strip + JSON coerce into a
 * typed `ReasoningPayload`) are DOMAIN operations reusable by any surface
 * (CLI, web, Tauri) — not arg-parse/render. The CLI command keeps only the
 * session-I/O preflight, the one LLM stream call, and ANSI rendering.
 *
 * Privacy: every payload shipped into the prompt passes through the shared
 * `redactValue` redactor BEFORE it leaves the host (Bearer/`sk-…`/email/PII
 * masking), and only the last {@link PRECEDING_SNIPPET_COUNT} message snippets
 * (each capped at {@link SNIPPET_CHAR_CAP} chars) are included — the full
 * session is never sent.
 *
 * Reads ONLY `@/llm` (Message TYPE), `@/session` (envelope record types +
 * `@/session/inspect-source` InspectGroup), `@/shared` (redactValue). No LLM
 * runtime call lives here — that stays in the surface so this slice carries no
 * provider dependency.
 */

import type { EventMsgRecord, SessionEnvelopeRecord } from "@/session"
import type { InspectGroup } from "@/session/inspect-source"
import { redactValue } from "@/shared"

/** System prompt for the meta-query. JSON-only, schema-pinned. */
export const META_SYSTEM_PROMPT =
  "You are an introspection assistant. Given a tool-call record from an AI " +
  "agent's session, explain in JSON why the agent likely made this call. " +
  'Output schema: {"goal": string, "reasoning": [string], ' +
  '"alternatives_considered": [string], "confidence": "high"|"medium"|"low"}. ' +
  "Output JSON only, no prose, no markdown fences."

/** Cap for raw text shipped per snippet (chars). */
export const SNIPPET_CHAR_CAP = 600
/** Number of preceding response_item snippets shipped as context. */
export const PRECEDING_SNIPPET_COUNT = 3

/* ─── prompt construction ────────────────────────────────────────────── */

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

/** Truncate `s` to `max` chars with a "(N more)" tail. */
export const truncForWire = (s: string, max: number): string => {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…(${s.length - max + 1} more)`
}

/** Run a single string through the shared trajectory redactor (treats the
 *  input as a one-field record so secret-shape values are masked). */
export const sanitiseString = (s: string): string => {
  const r = redactValue({ v: s }) as { v: unknown }
  const v = r.v
  return typeof v === "string" ? v : safeJson(v)
}

const firstTs = (g: InspectGroup): string | undefined => {
  const m = g.matches[0]?.record
  if (m && "ts" in (m as Record<string, unknown>)) {
    return (m as { ts?: string }).ts ?? undefined
  }
  return undefined
}

/** Up to {@link PRECEDING_SNIPPET_COUNT} preceding snippets (user_message
 *  events or assistant_text response_items) that appear BEFORE the matched
 *  group's first record. Never includes the future; each snippet is redacted
 *  + truncated. */
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
      out.push(`assistant: "${truncForWire(sanitiseString(env.content), SNIPPET_CHAR_CAP)}"`)
    }
  }
  return out.slice(Math.max(0, out.length - PRECEDING_SNIPPET_COUNT))
}

const appendPrecedingLines = (
  lines: string[],
  envelopes: readonly SessionEnvelopeRecord[],
  group: InspectGroup,
): void => {
  const preceding = precedingSnippets(envelopes, group)
  if (preceding.length === 0) return
  lines.push("Preceding context (last 3 messages):")
  for (const snip of preceding) lines.push(`  - ${snip}`)
  lines.push("")
}

const appendToolInvokeLines = (lines: string[], group: InspectGroup): void => {
  if (group.toolInvokes.length === 0) return
  const inv = group.toolInvokes[0] as Extract<EventMsgRecord, { kind: "tool_invoke" }>
  lines.push("Tool call:")
  lines.push(`  tool: ${inv.tool}`)
  lines.push(`  input: ${truncForWire(safeJson(redactValue(inv.input)), SNIPPET_CHAR_CAP)}`)
  lines.push("")
}

const appendDecisionLines = (lines: string[], group: InspectGroup): void => {
  if (group.decisions.length === 0) return
  lines.push("Decisions:")
  for (const d of group.decisions) {
    const extras: string[] = []
    if (d.rule_id !== undefined) extras.push(`rule=${d.rule_id}`)
    if (d.hook_name !== undefined) extras.push(`hook=${d.hook_name}`)
    const tail = extras.length === 0 ? "" : ` (${extras.join(", ")})`
    lines.push(`  ${d.gate}=${d.outcome} '${truncForWire(d.decision_reason, 200)}'${tail}`)
  }
  lines.push("")
}

const appendResultLines = (lines: string[], group: InspectGroup): void => {
  if (group.toolResults.length === 0) return
  const r = group.toolResults[group.toolResults.length - 1] as Extract<
    EventMsgRecord,
    { kind: "tool_result" }
  >
  const status = r.ok ? "ok" : "error"
  const outPreview = truncForWire(r.output.replace(/\n/g, "\\n"), 200)
  lines.push(`Result: ${status} — ${outPreview}`)
  lines.push("")
}

/** Build the meta-query user prompt: structured record of the tool call,
 *  preceding context, decisions, result summary. All payloads pass through
 *  `redactValue` BEFORE they leave the host. */
export const buildUserPrompt = (
  envelopes: readonly SessionEnvelopeRecord[],
  group: InspectGroup,
): string => {
  const lines: string[] = [
    group.turnId !== undefined ? `Session turn ${group.turnId}.` : "Session turn (unknown).",
    "",
  ]
  appendPrecedingLines(lines, envelopes, group)
  appendToolInvokeLines(lines, group)
  appendDecisionLines(lines, group)
  appendResultLines(lines, group)
  lines.push("Why did the agent make this call?")
  return lines.join("\n")
}

/* ─── reply parsing ──────────────────────────────────────────────────── */

export interface ReasoningPayload {
  readonly goal: string
  readonly reasoning: readonly string[]
  readonly alternativesConsidered: readonly string[]
  readonly confidence: "high" | "medium" | "low"
}

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low"])

/** Best-effort parse: strip optional markdown fences, parse JSON, coerce
 *  shape, return null on failure. NEVER throws. */
export const parseReasoning = (raw: string): ReasoningPayload | null => {
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
  const reasoning = Array.isArray(o.reasoning)
    ? o.reasoning.filter((s) => typeof s === "string")
    : null
  const alt = Array.isArray(o.alternatives_considered)
    ? o.alternatives_considered.filter((s) => typeof s === "string")
    : []
  if (reasoning === null) return null
  const conf =
    typeof o.confidence === "string" && CONFIDENCE_VALUES.has(o.confidence)
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
 *  Tolerant — any deviation falls through and the JSON.parse above catches
 *  the rest. */
export const stripFences = (s: string): string => {
  const trimmed = s.trim()
  const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed)
  if (fenceMatch !== null) return fenceMatch[1] ?? ""
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inner = trimmed.slice(3, -3)
    return inner.replace(/^json\s*/i, "").trim()
  }
  return trimmed
}
