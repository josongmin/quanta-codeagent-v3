import type { LLMPort, Message } from "@/llm"
import {
  EMBED_DIM,
  type EmbedderPort,
  type EvictionCaps,
  findNearDuplicates,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryTier,
  type PersistentStorePort,
  planEviction,
} from "@/memory"
import { EVICTION_DECAY } from "@/memory/eviction"
import { arbitrateConsolidation, type ConsolidationOp } from "./memory-consolidate"
import { distillSession, finalAssistantText } from "./memory-distill"

/**
 * Agent ↔ long-term memory orchestration (RFC §6.3, SOTA++ memory). Two
 * best-effort pipelines composed from the pure memory slice + the sibling
 * distill/consolidate/embedder modules:
 *
 * - {@link recallContext}: hybrid (lexical+vector) recall, reinforcement of
 *   the returned entries, folded into a compact "## Relevant memory" block.
 * - {@link persistSession}: distill → embed → consolidate → evict. Never
 *   throws; persistence is advisory and must never break a session.
 */

const RECALL_LIMIT = 5
const MAX_ENTRY_CHARS = 600

/** Tag every persisted session summary carries (see {@link persistSession}). */
export const SESSION_TAG = "session-summary"

/** Clamp `n` into `[lo, hi]` (NaN → `lo`). */
const clamp = (n: number, lo: number, hi: number): number =>
  Number.isNaN(n) ? lo : n < lo ? lo : n > hi ? hi : n

/** Small deterministic djb2 hash → hex. Stable id suffix across re-runs. */
const hashShort = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

/** Truncate `text` to {@link MAX_ENTRY_CHARS}, appending an ellipsis if cut. */
const truncate = (text: string): string =>
  text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text

/** Embed one string, returning the vector only if it is the expected dim. */
const embedOne = async (
  embedder: EmbedderPort | undefined,
  text: string,
): Promise<number[] | undefined> => {
  if (!embedder) return undefined
  try {
    const [vec] = await embedder.embed([text])
    return vec && vec.length === EMBED_DIM ? vec : undefined
  } catch {
    return undefined
  }
}

/** Fold entries into the system-prompt augmentation block (original format). */
const formatBlock = (entries: readonly MemoryEntry[]): string => {
  const lines = entries.map((e) => `- (${e.kind}) ${truncate(e.text)}`)
  return `## Relevant memory\n${lines.join("\n")}`
}

export interface RecallDeps {
  store: PersistentStorePort
  embedder?: EmbedderPort
}

/**
 * Recall the best matching entries as a system-prompt augmentation, or `null`
 * when the store has nothing relevant. When an embedder is present and the
 * query is non-empty the query is embedded for paraphrase-robust hybrid
 * recall (embedding failure silently degrades to lexical). Returned entries
 * are reinforced (access bump) best-effort.
 */
/** Bump access/recency/importance for recalled entries. Fully best-effort. */
const reinforce = async (
  store: PersistentStorePort,
  entries: readonly MemoryEntry[],
): Promise<void> => {
  try {
    for (const e of entries) {
      await store.update(e.id, {
        accessCount: (e.accessCount ?? 0) + 1,
        lastAccessedAt: Date.now(),
        importance: Math.min(1, (e.importance ?? 0.5) + 0.02),
      })
    }
  } catch {
    // Reinforcement is advisory; never break recall.
  }
}

export const recallContext = async (
  deps: RecallDeps,
  queryText: string | undefined,
  opts?: { limit?: number; tiers?: MemoryTier[] },
): Promise<string | null> => {
  const limit = opts?.limit ?? RECALL_LIMIT
  const text = queryText && queryText.length > 0 ? queryText : undefined
  const embedding = text ? await embedOne(deps.embedder, text) : undefined

  const query: MemoryQuery = { limit }
  if (text) query.text = text
  if (embedding) query.embedding = embedding
  if (opts?.tiers) query.tiers = opts.tiers

  let entries = await deps.store.recall(query)
  if (entries.length === 0) {
    entries = await deps.store.recall({ tags: [SESSION_TAG], limit })
  }
  if (entries.length === 0) return null

  await reinforce(deps.store, entries)
  return formatBlock(entries)
}

export interface PersistDeps {
  store: PersistentStorePort
  llm?: LLMPort
  embedder?: EmbedderPort
  /** Default true when `llm` present. */
  distill?: boolean
  /** Default true when `embedder` present. */
  consolidate?: boolean
  evictionCaps?: Partial<EvictionCaps>
  signal?: AbortSignal
}

export interface PersistInput {
  sessionId: string
  finalMessages: Message[]
}

interface DistilledRecord {
  kind: MemoryEntry["kind"]
  tier: MemoryTier
  text: string
  tags: string[]
  importance: number
}

/** Heuristic op when no LLM arbitration: skip on exact text dupe else insert. */
const heuristicOp = (candidate: MemoryEntry, dupes: readonly MemoryEntry[]): ConsolidationOp => {
  const norm = candidate.text.trim().toLowerCase()
  return dupes.some((d) => d.text.trim().toLowerCase() === norm)
    ? { action: "skip" }
    : { action: "insert" }
}

/** Distill durable records: LLM when enabled, else the final-text heuristic. */
const distillRecords = async (
  deps: PersistDeps,
  finalMessages: Message[],
): Promise<DistilledRecord[]> => {
  if (deps.llm && deps.distill !== false) {
    return distillSession(deps.llm, finalMessages, deps.signal ? { signal: deps.signal } : {})
  }
  const t = finalAssistantText(finalMessages)
  return t
    ? [{ kind: "decision", tier: "episodic", text: t, tags: [SESSION_TAG], importance: 0.4 }]
    : []
}

/** Build the persistable candidate entry for a distilled record. */
const buildCandidate = async (
  deps: PersistDeps,
  sessionId: string,
  record: DistilledRecord,
  now: number,
): Promise<MemoryEntry> => {
  const candidate: MemoryEntry = {
    id: `mem:${sessionId}:${hashShort(record.text)}`,
    kind: record.kind,
    tier: record.tier,
    text: record.text,
    tags: [...new Set([...record.tags, SESSION_TAG])],
    importance: record.importance,
    createdAt: now,
    sessionId,
  }
  const vec = await embedOne(deps.embedder, record.text)
  if (vec) candidate.embedding = vec
  return candidate
}

/** Pick the consolidation op (LLM-arbitrated or heuristic). */
const decideOp = async (
  deps: PersistDeps,
  candidate: MemoryEntry,
  dupes: readonly MemoryEntry[],
): Promise<ConsolidationOp> => {
  if (dupes.length === 0) return { action: "insert" }
  if (deps.llm && deps.consolidate !== false) {
    return arbitrateConsolidation(
      deps.llm,
      candidate,
      dupes,
      deps.signal ? { signal: deps.signal } : {},
    )
  }
  return heuristicOp(candidate, dupes)
}

/** Apply a consolidation op against the store. */
const applyOp = async (
  store: PersistentStorePort,
  candidate: MemoryEntry,
  op: ConsolidationOp,
): Promise<void> => {
  if (op.action === "insert") {
    await store.save(candidate)
  } else if (op.action === "merge") {
    await store.update(op.intoId, { text: op.text, tags: op.tags, importance: op.importance })
  } else if (op.action === "supersede") {
    await store.save(candidate)
    await store.update(op.oldId, { supersededBy: candidate.id })
  }
  // skip → nothing.
}

/** Whole-store eviction sweep (decay then delete). Best-effort per entry. */
const sweepEviction = async (deps: PersistDeps): Promise<void> => {
  const all = await deps.store.all()
  const plan = planEviction(all, deps.evictionCaps)
  const byId = new Map(all.map((e) => [e.id, e]))
  for (const id of plan.decay) {
    const e = byId.get(id)
    if (!e) continue
    try {
      await deps.store.update(id, {
        importance: clamp((e.importance ?? 0.5) * EVICTION_DECAY, 0, 1),
      })
    } catch {
      // Best-effort.
    }
  }
  for (const id of plan.delete) {
    try {
      await deps.store.delete(id)
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Distil the finished transcript into durable records and persist them
 * (embed → consolidate → evict). Best-effort by contract: any failure in the
 * whole pipeline is swallowed — a session must never fail because memory did.
 */
export const persistSession = async (deps: PersistDeps, input: PersistInput): Promise<void> => {
  try {
    const records = await distillRecords(deps, input.finalMessages)
    if (records.length === 0) return

    const now = Date.now()
    for (const record of records) {
      const candidate = await buildCandidate(deps, input.sessionId, record, now)
      const dupes = findNearDuplicates(candidate, await deps.store.all())
      const op = await decideOp(deps, candidate, dupes)
      await applyOp(deps.store, candidate, op)
    }

    await sweepEviction(deps)
  } catch {
    // Persistence is advisory; never propagate.
  }
}
