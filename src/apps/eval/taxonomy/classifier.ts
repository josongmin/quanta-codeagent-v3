/**
 * Query → UseCaseId classifier.
 *
 * One LLM call per query. The prompt enumerates every leaf with its label and
 * a representative example; the model is constrained to reply with a JSON
 * object `{ id, confidence, alt? }` where `id` is the chosen leaf id. The
 * parser is JSON-block tolerant so non-JSON-disciplined providers still work.
 *
 * Error surface contract (critical — no silent conflation):
 *
 *   - `error: undefined` AND `id: null` ⇒ MODEL deliberately picked "none of
 *     the above" (or returned an unknown id — same observable: no leaf fits).
 *   - `error: defined`                  ⇒ INFRA failure: stream errored,
 *     LLM returned no parseable JSON, etc. Caller MUST surface this as a
 *     distinct outcome (NOT lump into "unclassified") — silently treating an
 *     overloaded provider as "model couldn't decide" is the exact failure
 *     this surface forbids.
 *
 * Intentionally NOT a tool: this is a pure classification primitive
 * (`(LLMPort, query) → result`). Tier-3 trajectory labelling and ad-hoc CLI
 * (`eval classify <text>`) both consume it.
 */
import type { LLMPort, Message } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { errMessage } from "@/shared"
import type { UseCaseId } from "../types"
import { allLeaves, formatLeafLine, leafById } from "./index"

export interface ClassifyResult {
  /** Recognised leaf id, or `null` when the model picked an unknown/invalid id. */
  id: UseCaseId | null
  /** Self-reported confidence ∈ [0,1] when the model provides one. */
  confidence: number
  /** Optional secondary guesses (max 2), filtered to recognised ids. */
  alt: readonly UseCaseId[]
  /** Raw assistant text — useful for debugging classifier drift. */
  raw: string
  /** Set ONLY when the LLM stream itself failed or returned no JSON object.
   *  Callers MUST distinguish this from `id:null` (model decision). */
  error?: string
}

export interface ClassifyOpts {
  /** LLM adapter — its `model` is taken from the port (constructed elsewhere). */
  llm: LLMPort
  /** Limit alternates returned; default 2. */
  maxAlt?: number
}

const SYSTEM_PROMPT = [
  "You classify a developer's question or instruction to a coding agent.",
  "Reply with a SINGLE JSON object only — no prose, no markdown fences.",
  'Shape: { "id": "<leaf-id>", "confidence": 0.0-1.0, "alt": ["<leaf-id>", ...] }',
  "Use the EXACT leaf id from the list. If none fit, set id to null.",
].join("\n")

const buildUserPrompt = (query: string): string => {
  const lines = allLeaves().map(formatLeafLine)
  return [
    "Leaf catalog (id: label — example):",
    lines.join("\n"),
    "",
    "Query to classify:",
    query.trim(),
  ].join("\n")
}

/** Pull the first balanced `{...}` block from arbitrary text. */
const extractJsonObject = (s: string): string | null => {
  const start = s.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

interface RawShape {
  id?: unknown
  confidence?: unknown
  alt?: unknown
}

const errResult = (raw: string, error: string): ClassifyResult => ({
  id: null,
  confidence: 0,
  alt: [],
  raw,
  error,
})

const parse = (raw: string, maxAlt: number): ClassifyResult => {
  const block = extractJsonObject(raw)
  if (block === null) return errResult(raw, "no JSON object in response")
  let obj: RawShape
  try {
    obj = JSON.parse(block) as RawShape
  } catch (e) {
    return errResult(raw, `JSON parse: ${errMessage(e)}`)
  }
  // Model may legitimately reply `{"id": null}` — that's the "none of the
  // above" path and is NOT an error.
  const idRaw = typeof obj.id === "string" ? obj.id : null
  const id = idRaw !== null && leafById(idRaw) !== undefined ? idRaw : null
  const conf =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : 0
  const altIn = Array.isArray(obj.alt) ? obj.alt : []
  const alt: UseCaseId[] = []
  for (const a of altIn) {
    if (typeof a !== "string") continue
    if (a === id) continue
    if (leafById(a) === undefined) continue
    alt.push(a)
    if (alt.length >= maxAlt) break
  }
  return { id, confidence: conf, alt, raw }
}

export const classifyQuery = async (query: string, opts: ClassifyOpts): Promise<ClassifyResult> => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: buildUserPrompt(query) }] },
  ]
  const events = []
  try {
    for await (const e of opts.llm.stream({
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      messages,
      tools: [],
    })) {
      events.push(e)
    }
  } catch (e) {
    return errResult("", `llm stream: ${errMessage(e)}`)
  }
  const { message } = assembleFromEvents(events)
  const text = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
  return parse(text, opts.maxAlt ?? 2)
}
