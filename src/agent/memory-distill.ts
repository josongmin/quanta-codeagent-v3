import { z } from "zod"
import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import { MEMORY_KINDS, MEMORY_TIERS, type MemoryKind, type MemoryTier } from "@/memory"

/**
 * LLM-driven session distillation (RFC §6.3, SOTA++ memory). Reads a finished
 * transcript and extracts durable knowledge as structured memories. Never
 * throws — every failure path degrades to a single heuristic summary entry
 * (or `[]`), so the agent loop can call this unconditionally.
 */

export interface DistilledMemory {
  kind: MemoryKind
  tier: MemoryTier
  text: string
  tags: string[]
  importance: number
}

/** Last non-empty assistant text block across the transcript, trimmed. */
export const finalAssistantText = (messages: Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message
    if (m.role !== "assistant") continue
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
    if (text.length > 0) return text
  }
  return ""
}

/**
 * First balanced `open`..`close` span in `s`, string-literal aware (tolerates
 * ```json fences and surrounding prose). `null` if none. (~10 lines; per spec
 * duplicated in memory-consolidate.ts rather than shared in a new file.)
 */
const firstBalanced = (s: string, open: string, close: string): string | null => {
  const start = s.indexOf(open)
  if (start < 0) return null
  const st = { depth: 0, inStr: false, esc: false }
  for (let i = start; i < s.length; i++) {
    if (scanChar(st, s[i] as string, open, close)) return s.slice(start, i + 1)
  }
  return null
}

interface ScanState {
  depth: number
  inStr: boolean
  esc: boolean
}

/** Advance a balanced-scan over one char; true ⇒ the span just closed. */
const scanChar = (st: ScanState, c: string, open: string, close: string): boolean => {
  if (st.inStr) {
    if (st.esc) st.esc = false
    else if (c === "\\") st.esc = true
    else if (c === '"') st.inStr = false
    return false
  }
  if (c === '"') st.inStr = true
  else if (c === open) st.depth++
  else if (c === close) return --st.depth === 0
  return false
}

/**
 * Extract the first top-level JSON array substring from arbitrary model
 * output (tolerates ```json fences and surrounding prose). Returns `null`
 * when no balanced array is found.
 */
const firstJsonArray = (s: string): string | null => firstBalanced(s, "[", "]")

const clamp01 = (n: number): number => (Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0.5)

const rawSchema = z.array(
  z.object({
    kind: z.unknown(),
    tier: z.unknown(),
    text: z.unknown(),
    tags: z.unknown(),
    importance: z.unknown(),
  }),
)

const PROMPT = `You distill durable long-term memory from an agent session transcript.
Output ONLY a JSON array (no prose, no code fences) of objects with EXACTLY these fields:
  kind:       one of "fact" | "decision" | "observation" | "preference"
  tier:       "semantic" for durable knowledge; "episodic" for a session recap
  text:       a self-contained statement of the durable fact/decision/observation/preference
  tags:       array of short lowercase topic strings
  importance: number 0..1 (how valuable to remember later)
Rules: drop chit-chat, greetings, and transient scaffolding. Keep only knowledge
worth recalling in a future session. Most items are "semantic". Emit at most {MAX}
items, ordered most-important first. If nothing is worth keeping, output [].

TRANSCRIPT:
`

const serializeTranscript = (messages: Message[]): string =>
  messages
    .map((m) => {
      const body = m.content
        .map((b) => {
          if (b.type === "text") return b.text
          if (b.type === "tool_use") return `[tool_use ${b.name} ${JSON.stringify(b.input ?? {})}]`
          if (b.type === "tool_result") return `[tool_result ${b.content}]`
          if (b.type === "thinking") return `[thinking ${b.thinking}]`
          return ""
        })
        .join("\n")
      return `### ${m.role}\n${body}`
    })
    .join("\n\n")

const fallback = (messages: Message[]): DistilledMemory[] => {
  const text = finalAssistantText(messages)
  if (text.length === 0) return []
  return [
    {
      kind: "decision",
      tier: "episodic",
      text,
      tags: ["session-summary"],
      importance: 0.4,
    },
  ]
}

/** Concatenated, trimmed assistant text from an assembled turn's blocks. */
const assistantText = (message: Message): string =>
  message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()

/** Coerce one validated raw record into a {@link DistilledMemory}, or null. */
const toMemory = (r: z.infer<typeof rawSchema>[number]): DistilledMemory | null => {
  const t = typeof r.text === "string" ? r.text.trim() : ""
  if (t.length === 0) return null
  return {
    kind: MEMORY_KINDS.includes(r.kind as MemoryKind) ? (r.kind as MemoryKind) : "observation",
    tier: MEMORY_TIERS.includes(r.tier as MemoryTier) ? (r.tier as MemoryTier) : "semantic",
    text: t,
    tags: Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === "string") : [],
    importance: clamp01(typeof r.importance === "number" ? r.importance : Number(r.importance)),
  }
}

/** Parse model text → capped {@link DistilledMemory}[], or `null` to fall back. */
const parseDistilled = (text: string, max: number): DistilledMemory[] | null => {
  const json = firstJsonArray(text)
  if (!json) return null
  const parsed = rawSchema.safeParse(JSON.parse(json))
  if (!parsed.success || parsed.data.length === 0) return null
  const out: DistilledMemory[] = []
  for (const r of parsed.data) {
    if (out.length >= max) break
    const m = toMemory(r)
    if (m) out.push(m)
  }
  return out.length > 0 ? out : null
}

/**
 * Distill durable memories from a finished transcript via one LLM call.
 * Robust by contract: any failure (llm throws, no text, unparseable, empty,
 * or `opts.signal` aborted) → heuristic single-entry fallback or `[]`.
 */
export const distillSession = async (
  llm: LLMPort,
  messages: Message[],
  opts?: { signal?: AbortSignal; max?: number },
): Promise<DistilledMemory[]> => {
  const max = opts?.max ?? 8
  if (opts?.signal?.aborted) return fallback(messages)
  try {
    const prompt = PROMPT.replace("{MAX}", String(max)) + serializeTranscript(messages)
    const events: StreamEvent[] = []
    for await (const ev of llm.stream({
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      tools: [],
    })) {
      if (opts?.signal?.aborted) return fallback(messages)
      events.push(ev)
    }
    const { message } = assembleFromEvents(events)
    return parseDistilled(assistantText(message), max) ?? fallback(messages)
  } catch {
    return fallback(messages)
  }
}
