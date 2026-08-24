import type { LLMPort, Message } from "@/llm"
import {
  EMBED_DIM,
  type EmbedderPort,
  EVICTION_DECAY,
  type EvictionCaps,
  findNearDuplicates,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryTelemetryPort,
  type MemoryTier,
  type PersistentStorePort,
  planEviction,
  type RoutingContext,
  scoreEntry,
} from "@/memory"
import { sliceWholeChars, throwIfAborted } from "@/shared"
import { arbitrateConsolidation, type ConsolidationOp } from "./memory-consolidate"
import { distillSession, finalAssistantText } from "./memory-distill"
import { emptyPersistStats, type PersistStats, type RecallStats } from "./memory-stats"

/**
 * One placed-in-window record (ADR-0082 memory_citation provenance — the
 * memory-side half of the signal, before the prompt assembler stamps the
 * `where` field). Emitted by {@link recallContext} via `onPlaced` for every
 * entry that survives the recall-limit budget and is folded into the rendered
 * block — i.e. exactly the entries that go into the prompt window. The score
 * is the deterministic weighted-sum {@link rankEntries} computed; callers
 * (the loop) join this against the rendering seam to mint a
 * {@link import("./types").MemoryCitation}.
 */
export interface PlacedRecord {
  /** The record's stable id (matches `MemoryEntry.id`). */
  readonly recordId: string
  /** Weighted-sum recall score (the value that placed it in the budget). */
  readonly score: number
  /** Approximate token cost of the rendered text line — `chars/4` heuristic
   *  matching the rest of the loop's estimator. */
  readonly tokensApprox: number
}

/**
 * Agent ↔ long-term memory orchestration (RFC §6.3). Two
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
  text.length > MAX_ENTRY_CHARS ? `${sliceWholeChars(text, MAX_ENTRY_CHARS)}…` : text

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

/**
 * Recall-budget visibility hint. When the ranker SCANNED more candidate
 * memories (`scanned` = N) than it INJECTED (`injected` = K, the post-limit
 * count), the recalled block is a TRUNCATED top-K view — the model has no way
 * to know more exist unless we say so. Returns the one-line disclosure in that
 * case, else `undefined` (no line ⇒ no noise when everything fit).
 *
 * K/N are the ranker's own counts (the SAME values it emits on the telemetry
 * seam — `hits` / `totalScanned`); this helper does NOT recompute relevance or
 * apply any new heuristic. It is purely the budget readout.
 */
export const recallBudgetHint = (injected: number, scanned: number): string | undefined =>
  scanned > injected
    ? `(recalled ${injected} of ${scanned} candidate memories — use memory_search for more)`
    : undefined

/** Fold entries into the system-prompt augmentation block. The H2 carries the
 *  trust-ladder downgrade verbatim (Codex `memory-model-audit.md`): recalled
 *  memory is a ROUTING HINT, never proof. The prompt-side renderer no longer
 *  prefixes a second label, so there's exactly one H2 for the memory block.
 *
 *  `scanned` (the ranker's candidate total) drives the recall-budget hint
 *  (see {@link recallBudgetHint}). When it exceeds the rendered entry count
 *  the truncation disclosure is appended UNDER the same H2 (still inside the
 *  one "routing hints only — not proof" frame); when it doesn't (or is
 *  omitted) the block is byte-identical to the legacy shape. */
const formatBlock = (entries: readonly MemoryEntry[], scanned?: number): string => {
  const lines = entries.map((e) => `- (${e.kind}) ${truncate(e.text)}`)
  const hint = scanned === undefined ? undefined : recallBudgetHint(entries.length, scanned)
  const body = hint === undefined ? lines.join("\n") : `${lines.join("\n")}\n${hint}`
  return `## Memory hints (routing hints only — not proof)\n${body}`
}

/** Invoke an optional stats observer; an observer throw must never escape. */
const emitStats = <S>(cb: ((s: S) => void) | undefined, stats: S): void => {
  if (!cb) return
  try {
    cb(stats)
  } catch {
    // Observability is advisory; never let it break recall/persist.
  }
}

export interface RecallDeps {
  store: PersistentStorePort
  embedder?: EmbedderPort
  /**
   * Optional observability hook (locked seam, see memory-stats.ts). Invoked
   * exactly once per {@link recallContext} call with the recall outcome.
   */
  onStats?: (s: RecallStats) => void
  /**
   * ADR-0082 memory_citation provenance — invoked at most ONCE per
   * {@link recallContext} call, immediately before the formatted block is
   * returned, with the ordered list of placed records (in the same order
   * they appear in the rendered block). When the recall finds no entries the
   * callback is NOT invoked (no signal to emit). Best-effort by contract:
   * an `onPlaced` throw is swallowed (mirrors {@link emitStats}) so the
   * citation signal can never break recall.
   *
   * The loop's accumulator joins each PlacedRecord against the rendering
   * seam (system_prompt | reminder_tail | tool_result_injection) to mint a
   * full {@link import("./types").MemoryCitation}.
   */
  onPlaced?: (placed: readonly PlacedRecord[]) => void
  /**
   * Wall-clock injection seam. Defaults to {@link Date.now}. Tests inject a
   * fixed function so freshness/eviction thresholds (40d) are deterministic
   * regardless of CI clock skew.
   */
  now?: () => number
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
  now: () => number,
): Promise<void> => {
  try {
    for (const e of entries) {
      await store.update(e.id, {
        accessCount: (e.accessCount ?? 0) + 1,
        lastAccessedAt: now(),
        importance: Math.min(1, (e.importance ?? 0.5) + 0.02),
      })
    }
  } catch {
    // Reinforcement is advisory; never break recall.
  }
}

/**
 * Assemble the store query for one recall.
 *
 * A unit because every optional field here is *conditionally present* under
 * `exactOptionalPropertyTypes` — the assignments must stay together so the
 * "absent vs. present-but-undefined" distinction that drives ranking is
 * decided in exactly one place.
 */
const buildRecallQuery = (
  limit: number,
  text: string | undefined,
  embedding: number[] | undefined,
  opts?: { tiers?: MemoryTier[]; routing?: RoutingContext },
): MemoryQuery => {
  const query: MemoryQuery = { limit }
  if (text) query.text = text
  if (embedding) query.embedding = embedding
  if (opts?.tiers) query.tiers = opts.tiers
  // §10.6 routing weighting — opt-in. Only set `query.routing` when the caller
  // supplied a NON-EMPTY routing context (the composition root gates this on
  // QUANTA_MEMORY_ROUTING). Absent / empty ⇒ ranking is byte-identical.
  if (opts?.routing && (opts.routing.taskGroup || opts.routing.cwd)) {
    query.routing = opts.routing
  }
  return query
}

export const recallContext = async (
  deps: RecallDeps,
  queryText: string | undefined,
  opts?: { limit?: number; tiers?: MemoryTier[]; routing?: RoutingContext },
): Promise<string | null> => {
  const limit = opts?.limit ?? RECALL_LIMIT
  const text = queryText && queryText.length > 0 ? queryText : undefined
  const embedding = text ? await embedOne(deps.embedder, text) : undefined

  const query = buildRecallQuery(limit, text, embedding, opts)

  // Capturing telemetry sink: reuse the ranker's content-free counts (the
  // SAME `hits`/`totalScanned` it emits) to drive the recall-budget hint, so
  // the disclosure never recomputes relevance with a fresh heuristic. Only the
  // candidate total (`totalScanned`) is read; entry text/scores never cross it.
  // `scanned` tracks whichever recall actually produced the rendered entries
  // (primary, or the tag-only fallback below).
  let scanned: number | undefined
  const countSink: MemoryTelemetryPort = {
    recordPhase1: () => {},
    recordPhase2: () => {},
    recordRecall: (e) => {
      scanned = e.totalScanned
    },
  }

  let entries = await deps.store.recall(query, countSink)
  let fellBack = false
  let queryForScore: MemoryQuery = query
  if (entries.length === 0) {
    // Fallback query: ranking now operates on TAG-only, so the score we
    // attach to citations must reflect THAT query (else the score we report
    // is the score from the empty first-query attempt, not the score that
    // actually placed the entry). Use the same tag-only query for scoring.
    queryForScore = { tags: [SESSION_TAG], limit }
    entries = await deps.store.recall(queryForScore, countSink)
    fellBack = true
  }
  if (entries.length === 0) {
    emitStats(deps.onStats, { recalled: 0, embedded: Boolean(embedding), fellBack })
    return null
  }

  await reinforce(deps.store, entries, deps.now ?? Date.now)
  emitStats(deps.onStats, {
    recalled: entries.length,
    embedded: Boolean(embedding),
    fellBack,
  })
  // ADR-0082 — emit placed-record provenance BEFORE returning the rendered
  // block. The store's `recall` already enforces `query.limit` (the recall
  // budget), so every `entries[]` row IS a record that survived the budget
  // and is folded into the rendered block. Best-effort: a host-callback
  // throw is swallowed (citations are observability — never break recall).
  if (deps.onPlaced) {
    const now = (deps.now ?? Date.now)()
    const placed: PlacedRecord[] = entries.map((e) => ({
      recordId: e.id,
      score: scoreEntry(e, queryForScore, now),
      // chars/4 against the SAME truncate() the block renderer applies, so
      // the surfaced tokensApprox matches the size that landed in the prompt.
      tokensApprox: Math.ceil(truncate(e.text).length / 4),
    }))
    try {
      deps.onPlaced(placed)
    } catch {
      // Observability is advisory; never let it break recall.
    }
  }
  return formatBlock(entries, scanned)
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
  /**
   * Optional observability hook (locked seam, see memory-stats.ts). Invoked
   * exactly once per {@link persistSession} call with the persist outcome
   * (best-effort with whatever was counted even when the pipeline errors).
   */
  onStats?: (s: PersistStats) => void
  /**
   * Wall-clock injection seam. Defaults to {@link Date.now}. Tests inject a
   * fixed function so freshness/eviction thresholds (40d) are deterministic
   * regardless of CI clock skew.
   */
  now?: () => number
  /**
   * ADR-0078 — when set, the distill input (serialized transcript) is
   * redacted before crossing the LLM call. `disabled === true` ⇒ caller
   * acknowledged the risk (validated at agent startup). Absent ⇒ legacy
   * unredacted distill (preserved for non-loop callers and tests). The
   * loop sets these unconditionally.
   */
  redactionDisabled?: boolean
  redactionWhitelist?: ReadonlyArray<RegExp>
  /** ADR-0078 — invoked once with hits aggregated by the distiller. */
  onRedactionHits?: (hits: ReadonlyArray<import("@/security").RedactionHit>) => void
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
    return distillSession(deps.llm, finalMessages, {
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.redactionDisabled === true ? { redactionDisabled: true } : {}),
      ...(deps.redactionWhitelist ? { redactionWhitelist: deps.redactionWhitelist } : {}),
      ...(deps.onRedactionHits ? { onRedactionHits: deps.onRedactionHits } : {}),
    })
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

/**
 * Apply a consolidation op against the store, recording the outcome.
 *
 * C10: also mirrors the exact same mutation into the caller's single
 * `snapshot` array (push on save; in-place field update on merge/supersede)
 * so the next record's dedup + the final eviction sweep observe prior ops
 * WITHOUT a fresh `store.all()` scan. The snapshot tracks the store in
 * lock-step, so dedup/eviction OUTCOMES stay byte-for-byte identical to the
 * old per-record-rescan version — only the query count drops (O(records) → 1).
 */
const applyOp = async (
  store: PersistentStorePort,
  candidate: MemoryEntry,
  op: ConsolidationOp,
  stats: PersistStats,
  snapshot: MemoryEntry[],
): Promise<void> => {
  if (op.action === "insert") {
    await store.save(candidate)
    snapshot.push(candidate)
    stats.inserted++
  } else if (op.action === "merge") {
    await store.update(op.intoId, { text: op.text, tags: op.tags, importance: op.importance })
    const into = snapshot.find((e) => e.id === op.intoId)
    if (into) {
      into.text = op.text
      into.tags = op.tags
      into.importance = op.importance
    }
    stats.merged++
  } else if (op.action === "supersede") {
    await store.save(candidate)
    snapshot.push(candidate)
    await store.update(op.oldId, { supersededBy: candidate.id })
    const old = snapshot.find((e) => e.id === op.oldId)
    if (old) old.supersededBy = candidate.id
    stats.superseded++
  } else {
    stats.skipped++
  }
}

/**
 * Whole-store eviction sweep (decay then delete). Best-effort per entry.
 * `all` is the caller's single store snapshot (C10: no extra `store.all()`
 * scan here) — it already includes records inserted earlier this persist.
 */
const sweepEviction = async (
  deps: PersistDeps,
  stats: PersistStats,
  all: readonly MemoryEntry[],
  now: number,
): Promise<void> => {
  // Audit C-20: honor caller cancellation before starting the sweep — and at
  // the head of each decay/delete iteration — using the T01 shared primitive
  // (no local abort helper). The AbortError propagates to persistSession's
  // best-effort catch, which returns early with whatever stats accrued.
  throwIfAborted(deps.signal)
  const plan = planEviction(all, deps.evictionCaps, now)
  const byId = new Map(all.map((e) => [e.id, e]))
  for (const id of plan.decay) {
    throwIfAborted(deps.signal)
    const e = byId.get(id)
    if (!e) continue
    try {
      // ADR-0554: stamp the dedicated decay clock so the next sweep within the
      // same age window skips this entry (decay per elapsed time, not per
      // session). `updatedAt` is NOT usable here — adapters/reinforce() bump it.
      await deps.store.update(id, {
        importance: clamp((e.importance ?? 0.5) * EVICTION_DECAY, 0, 1),
        lastDecayedAt: now,
      })
      stats.decayed++
    } catch {
      // Best-effort.
    }
  }
  for (const id of plan.delete) {
    throwIfAborted(deps.signal)
    try {
      await deps.store.delete(id)
      stats.deleted++
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
  const stats = emptyPersistStats()
  try {
    const records = await distillRecords(deps, input.finalMessages)
    stats.distilled = records.length
    if (records.length === 0) {
      emitStats(deps.onStats, stats)
      return
    }

    // C10: ONE store.all() snapshot for the whole persist. applyOp mirrors
    // every save/merge/supersede into it, so per-record dedup + the eviction
    // sweep below read the live in-memory mirror instead of re-scanning the
    // whole store O(records+1) times. Outcomes are unchanged (the mirror is
    // kept in lock-step with the store); only the scan count drops to 1.
    const snapshot: MemoryEntry[] = [...(await deps.store.all())]

    const now = (deps.now ?? Date.now)()
    // Audit C-20: a mid-persist cancel must stop the loop — previously only the
    // distill phase observed the signal, so persist kept committing records the
    // caller no longer wanted. The throw lands in the best-effort catch below
    // (early return with whatever was already saved).
    throwIfAborted(deps.signal)
    for (const record of records) {
      throwIfAborted(deps.signal)
      const candidate = await buildCandidate(deps, input.sessionId, record, now)
      const dupes = findNearDuplicates(candidate, snapshot)
      const op = await decideOp(deps, candidate, dupes)
      await applyOp(deps.store, candidate, op, stats, snapshot)
    }

    await sweepEviction(deps, stats, snapshot, now)
    emitStats(deps.onStats, stats)
  } catch {
    // Persistence is advisory; never propagate. Still emit whatever was
    // counted before the failure (best-effort; emitStats never throws).
    emitStats(deps.onStats, stats)
  }
}
