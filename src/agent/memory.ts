import type { Message } from "@/llm"
import type { MemoryEntry, MemoryQuery, PersistentStorePort } from "@/memory"

/**
 * Agent ↔ long-term memory glue (RFC §6.3, Phase 1.5). Two pure-ish helpers:
 *
 * - {@link recallContext}: query the store and fold the top entries into a
 *   compact "## Relevant memory" block to prepend to the system prompt.
 * - {@link persistSession}: heuristically extract a durable record from the
 *   finished transcript and save it. No LLM call here (RFC: keep the heuristic
 *   simple and documented) — we persist the FINAL assistant text, which in a
 *   ReAct loop is the model's own wrap-up / decision summary. That is the
 *   highest-signal, lowest-noise artifact available without another model call.
 */

const RECALL_LIMIT = 5
const MAX_ENTRY_CHARS = 600

/** Tag every persisted session summary carries (see {@link persistSession}). */
export const SESSION_TAG = "session-summary"

/**
 * Format the best matching entries as a system-prompt augmentation, or `null`
 * when the store has nothing relevant. Caller appends this to its own system
 * string copy (never mutating the original).
 *
 * The caller's free-text query is advisory: `MemoryQuery.text` is a *hard*
 * substring filter in the ranking layer, so a paraphrased user prompt would
 * filter out every prior summary. We therefore always fall back to recalling
 * recent {@link SESSION_TAG} entries when a text query returns nothing, so a
 * follow-up session still sees what the last one decided.
 */
export const recallContext = async (
  store: PersistentStorePort,
  query: MemoryQuery,
): Promise<string | null> => {
  const limit = query.limit ?? RECALL_LIMIT
  let entries = await store.recall({ ...query, limit })
  if (entries.length === 0) {
    entries = await store.recall({ tags: [SESSION_TAG], limit })
  }
  if (entries.length === 0) return null
  const lines = entries.map((e) => {
    const text = e.text.length > MAX_ENTRY_CHARS ? `${e.text.slice(0, MAX_ENTRY_CHARS)}…` : e.text
    return `- (${e.kind}) ${text}`
  })
  return `## Relevant memory\n${lines.join("\n")}`
}

/** Last assistant text block content across the transcript, trimmed. */
const finalAssistantText = (messages: Message[]): string => {
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

export interface PersistInput {
  sessionId: string
  finalMessages: Message[]
}

/**
 * Persist a single durable `decision` entry distilling the session, derived
 * from the final assistant summary text. No-op when there is nothing textual
 * to keep (e.g. aborted before any assistant prose).
 */
export const persistSession = async (
  store: PersistentStorePort,
  input: PersistInput,
): Promise<void> => {
  const text = finalAssistantText(input.finalMessages)
  if (text.length === 0) return
  const entry: MemoryEntry = {
    id: `session:${input.sessionId}`,
    kind: "decision",
    text,
    tags: [SESSION_TAG],
    createdAt: Date.now(),
    sessionId: input.sessionId,
  }
  await store.save(entry)
}
