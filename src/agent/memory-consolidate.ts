import { z } from "zod"
import { assembleFromEvents, type LLMPort, type StreamEvent } from "@/llm"
import type { MemoryEntry } from "@/memory"

/**
 * LLM-arbitrated memory consolidation (RFC §6.3, long-term memory). Given a new
 * candidate and its near-duplicates, decide the op that preserves knowledge
 * without loss. Never throws — llm/parse failures fall back to a
 * token-Jaccard heuristic.
 */

export type ConsolidationOp =
  | { action: "insert" }
  | { action: "skip" }
  | { action: "merge"; intoId: string; text: string; tags: string[]; importance: number }
  | { action: "supersede"; oldId: string }

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
 * First balanced `open`..`close` span in `s`, string-literal aware (tolerates
 * ```json fences and surrounding prose). `null` if none. (~10 lines; per spec
 * duplicated in memory-distill.ts rather than shared in a new file.)
 */
const firstBalanced = (s: string, open: string, close: string): string | null => {
  const start = s.indexOf(open)
  if (start < 0) return null
  const st: ScanState = { depth: 0, inStr: false, esc: false }
  for (let i = start; i < s.length; i++) {
    if (scanChar(st, s[i] as string, open, close)) return s.slice(start, i + 1)
  }
  return null
}

/**
 * Extract the first balanced top-level JSON object from arbitrary model
 * output (tolerates ```json fences and surrounding prose). `null` if none.
 */
const firstJsonObject = (s: string): string | null => firstBalanced(s, "{", "}")

const norm = (s: string): string => s.trim().toLowerCase()

const tokens = (s: string): Set<string> =>
  new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  )

/** Token Jaccard similarity of two strings in [0,1]. */
const jaccard = (a: string, b: string): number => {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/** Highest-Jaccard dupe + its score (dupes guaranteed non-empty). */
const bestDupe = (
  candidate: MemoryEntry,
  dupes: readonly MemoryEntry[],
): { entry: MemoryEntry; score: number } => {
  let best = { entry: dupes[0] as MemoryEntry, score: -1 }
  for (const d of dupes) {
    const score = jaccard(candidate.text, d.text)
    if (score > best.score) best = { entry: d, score }
  }
  return best
}

const heuristic = (candidate: MemoryEntry, dupes: readonly MemoryEntry[]): ConsolidationOp => {
  const { entry, score } = bestDupe(candidate, dupes)
  return score >= 0.8 ? { action: "supersede", oldId: entry.id } : { action: "insert" }
}

const opSchema = z.union([
  z.object({ action: z.literal("insert") }),
  z.object({ action: z.literal("skip") }),
  z.object({
    action: z.literal("merge"),
    intoId: z.string(),
    text: z.string(),
    tags: z.array(z.string()),
    importance: z.number(),
  }),
  z.object({ action: z.literal("supersede"), oldId: z.string() }),
])

const PROMPT = `You consolidate a new candidate memory against existing near-duplicate
memories so that knowledge is preserved WITHOUT loss. Choose exactly one op and
output ONLY a JSON object (no prose, no code fences):
  {"action":"insert"}                              keep candidate as a new distinct entry
  {"action":"skip"}                                candidate adds nothing new (drop it)
  {"action":"merge","intoId":"<id>","text":"<merged>","tags":[...],"importance":0..1}
                                                   fold candidate into an existing entry
  {"action":"supersede","oldId":"<id>"}            candidate replaces an outdated entry
intoId/oldId MUST be one of the provided existing-entry ids.

CANDIDATE:
{CANDIDATE}

EXISTING NEAR-DUPLICATES:
{DUPES}
`

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Validate model text into a {@link ConsolidationOp}. `null` ⇒ caller falls
 * back to the heuristic (no JSON, schema mismatch, or out-of-set id).
 */
const interpret = (text: string, ids: ReadonlySet<string>): ConsolidationOp | null => {
  const json = firstJsonObject(text)
  if (!json) return null
  const parsed = opSchema.safeParse(JSON.parse(json))
  if (!parsed.success) return null
  const op = parsed.data
  if (op.action === "merge") {
    if (!ids.has(op.intoId)) return null
    return {
      action: "merge",
      intoId: op.intoId,
      text: op.text,
      tags: op.tags,
      importance: clamp01(op.importance),
    }
  }
  if (op.action === "supersede" && !ids.has(op.oldId)) return null
  return op
}

const buildPrompt = (candidate: MemoryEntry, dupes: readonly MemoryEntry[]): string =>
  PROMPT.replace(
    "{CANDIDATE}",
    JSON.stringify({ text: candidate.text, importance: candidate.importance ?? 0.5 }),
  ).replace(
    "{DUPES}",
    JSON.stringify(dupes.map((d) => ({ id: d.id, text: d.text, importance: d.importance ?? 0.5 }))),
  )

/**
 * Decide how to consolidate `candidate` against `dupes`. Short-circuits
 * without an LLM call when there are no dupes (insert) or an exact
 * case-insensitive text match exists (skip). Otherwise asks the model;
 * any failure or an out-of-set merge/supersede id → Jaccard heuristic.
 */
export const arbitrateConsolidation = async (
  llm: LLMPort,
  candidate: MemoryEntry,
  dupes: readonly MemoryEntry[],
  opts?: { signal?: AbortSignal },
): Promise<ConsolidationOp> => {
  if (dupes.length === 0) return { action: "insert" }
  const candNorm = norm(candidate.text)
  if (dupes.some((d) => norm(d.text) === candNorm)) return { action: "skip" }
  if (opts?.signal?.aborted) return heuristic(candidate, dupes)
  try {
    const events: StreamEvent[] = []
    for await (const ev of llm.stream({
      messages: [
        { role: "user", content: [{ type: "text", text: buildPrompt(candidate, dupes) }] },
      ],
      tools: [],
    })) {
      if (opts?.signal?.aborted) return heuristic(candidate, dupes)
      events.push(ev)
    }
    const { message } = assembleFromEvents(events)
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
    const ids = new Set(dupes.map((d) => d.id))
    return interpret(text, ids) ?? heuristic(candidate, dupes)
  } catch {
    return heuristic(candidate, dupes)
  }
}
