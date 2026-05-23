import { EMBED_DIM, EVICTION_DECAY, findNearDuplicates, planEviction, scoreEntry, } from "@/memory";
import { arbitrateConsolidation } from "./memory-consolidate";
import { distillSession, finalAssistantText } from "./memory-distill";
import { emptyPersistStats } from "./memory-stats";
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
const RECALL_LIMIT = 5;
const MAX_ENTRY_CHARS = 600;
/** Tag every persisted session summary carries (see {@link persistSession}). */
export const SESSION_TAG = "session-summary";
/** Clamp `n` into `[lo, hi]` (NaN → `lo`). */
const clamp = (n, lo, hi) => Number.isNaN(n) ? lo : n < lo ? lo : n > hi ? hi : n;
/** Small deterministic djb2 hash → hex. Stable id suffix across re-runs. */
const hashShort = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16);
};
/** Truncate `text` to {@link MAX_ENTRY_CHARS}, appending an ellipsis if cut. */
const truncate = (text) => text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
/** Embed one string, returning the vector only if it is the expected dim. */
const embedOne = async (embedder, text) => {
    if (!embedder)
        return undefined;
    try {
        const [vec] = await embedder.embed([text]);
        return vec && vec.length === EMBED_DIM ? vec : undefined;
    }
    catch {
        return undefined;
    }
};
/** Fold entries into the system-prompt augmentation block. The H2 carries the
 *  trust-ladder downgrade verbatim (Codex `memory-model-audit.md`): recalled
 *  memory is a ROUTING HINT, never proof. The prompt-side renderer no longer
 *  prefixes a second label, so there's exactly one H2 for the memory block. */
const formatBlock = (entries) => {
    const lines = entries.map((e) => `- (${e.kind}) ${truncate(e.text)}`);
    return `## Memory hints (routing hints only — not proof)\n${lines.join("\n")}`;
};
/** Invoke an optional stats observer; an observer throw must never escape. */
const emitStats = (cb, stats) => {
    if (!cb)
        return;
    try {
        cb(stats);
    }
    catch {
        // Observability is advisory; never let it break recall/persist.
    }
};
/**
 * Recall the best matching entries as a system-prompt augmentation, or `null`
 * when the store has nothing relevant. When an embedder is present and the
 * query is non-empty the query is embedded for paraphrase-robust hybrid
 * recall (embedding failure silently degrades to lexical). Returned entries
 * are reinforced (access bump) best-effort.
 */
/** Bump access/recency/importance for recalled entries. Fully best-effort. */
const reinforce = async (store, entries, now) => {
    try {
        for (const e of entries) {
            await store.update(e.id, {
                accessCount: (e.accessCount ?? 0) + 1,
                lastAccessedAt: now(),
                importance: Math.min(1, (e.importance ?? 0.5) + 0.02),
            });
        }
    }
    catch {
        // Reinforcement is advisory; never break recall.
    }
};
export const recallContext = async (deps, queryText, opts) => {
    const limit = opts?.limit ?? RECALL_LIMIT;
    const text = queryText && queryText.length > 0 ? queryText : undefined;
    const embedding = text ? await embedOne(deps.embedder, text) : undefined;
    const query = { limit };
    if (text)
        query.text = text;
    if (embedding)
        query.embedding = embedding;
    if (opts?.tiers)
        query.tiers = opts.tiers;
    let entries = await deps.store.recall(query);
    let fellBack = false;
    let queryForScore = query;
    if (entries.length === 0) {
        // Fallback query: ranking now operates on TAG-only, so the score we
        // attach to citations must reflect THAT query (else the score we report
        // is the score from the empty first-query attempt, not the score that
        // actually placed the entry). Use the same tag-only query for scoring.
        queryForScore = { tags: [SESSION_TAG], limit };
        entries = await deps.store.recall(queryForScore);
        fellBack = true;
    }
    if (entries.length === 0) {
        emitStats(deps.onStats, { recalled: 0, embedded: Boolean(embedding), fellBack });
        return null;
    }
    await reinforce(deps.store, entries, deps.now ?? Date.now);
    emitStats(deps.onStats, {
        recalled: entries.length,
        embedded: Boolean(embedding),
        fellBack,
    });
    // ADR-0082 — emit placed-record provenance BEFORE returning the rendered
    // block. The store's `recall` already enforces `query.limit` (the recall
    // budget), so every `entries[]` row IS a record that survived the budget
    // and is folded into the rendered block. Best-effort: a host-callback
    // throw is swallowed (citations are observability — never break recall).
    if (deps.onPlaced) {
        const now = (deps.now ?? Date.now)();
        const placed = entries.map((e) => ({
            recordId: e.id,
            score: scoreEntry(e, queryForScore, now),
            // chars/4 against the SAME truncate() the block renderer applies, so
            // the surfaced tokensApprox matches the size that landed in the prompt.
            tokensApprox: Math.ceil(truncate(e.text).length / 4),
        }));
        try {
            deps.onPlaced(placed);
        }
        catch {
            // Observability is advisory; never let it break recall.
        }
    }
    return formatBlock(entries);
};
/** Heuristic op when no LLM arbitration: skip on exact text dupe else insert. */
const heuristicOp = (candidate, dupes) => {
    const norm = candidate.text.trim().toLowerCase();
    return dupes.some((d) => d.text.trim().toLowerCase() === norm)
        ? { action: "skip" }
        : { action: "insert" };
};
/** Distill durable records: LLM when enabled, else the final-text heuristic. */
const distillRecords = async (deps, finalMessages) => {
    if (deps.llm && deps.distill !== false) {
        return distillSession(deps.llm, finalMessages, {
            ...(deps.signal ? { signal: deps.signal } : {}),
            ...(deps.redactionDisabled === true ? { redactionDisabled: true } : {}),
            ...(deps.redactionWhitelist ? { redactionWhitelist: deps.redactionWhitelist } : {}),
            ...(deps.onRedactionHits ? { onRedactionHits: deps.onRedactionHits } : {}),
        });
    }
    const t = finalAssistantText(finalMessages);
    return t
        ? [{ kind: "decision", tier: "episodic", text: t, tags: [SESSION_TAG], importance: 0.4 }]
        : [];
};
/** Build the persistable candidate entry for a distilled record. */
const buildCandidate = async (deps, sessionId, record, now) => {
    const candidate = {
        id: `mem:${sessionId}:${hashShort(record.text)}`,
        kind: record.kind,
        tier: record.tier,
        text: record.text,
        tags: [...new Set([...record.tags, SESSION_TAG])],
        importance: record.importance,
        createdAt: now,
        sessionId,
    };
    const vec = await embedOne(deps.embedder, record.text);
    if (vec)
        candidate.embedding = vec;
    return candidate;
};
/** Pick the consolidation op (LLM-arbitrated or heuristic). */
const decideOp = async (deps, candidate, dupes) => {
    if (dupes.length === 0)
        return { action: "insert" };
    if (deps.llm && deps.consolidate !== false) {
        return arbitrateConsolidation(deps.llm, candidate, dupes, deps.signal ? { signal: deps.signal } : {});
    }
    return heuristicOp(candidate, dupes);
};
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
const applyOp = async (store, candidate, op, stats, snapshot) => {
    if (op.action === "insert") {
        await store.save(candidate);
        snapshot.push(candidate);
        stats.inserted++;
    }
    else if (op.action === "merge") {
        await store.update(op.intoId, { text: op.text, tags: op.tags, importance: op.importance });
        const into = snapshot.find((e) => e.id === op.intoId);
        if (into) {
            into.text = op.text;
            into.tags = op.tags;
            into.importance = op.importance;
        }
        stats.merged++;
    }
    else if (op.action === "supersede") {
        await store.save(candidate);
        snapshot.push(candidate);
        await store.update(op.oldId, { supersededBy: candidate.id });
        const old = snapshot.find((e) => e.id === op.oldId);
        if (old)
            old.supersededBy = candidate.id;
        stats.superseded++;
    }
    else {
        stats.skipped++;
    }
};
/**
 * Whole-store eviction sweep (decay then delete). Best-effort per entry.
 * `all` is the caller's single store snapshot (C10: no extra `store.all()`
 * scan here) — it already includes records inserted earlier this persist.
 */
const sweepEviction = async (deps, stats, all, now) => {
    const plan = planEviction(all, deps.evictionCaps, now);
    const byId = new Map(all.map((e) => [e.id, e]));
    for (const id of plan.decay) {
        const e = byId.get(id);
        if (!e)
            continue;
        try {
            await deps.store.update(id, {
                importance: clamp((e.importance ?? 0.5) * EVICTION_DECAY, 0, 1),
            });
            stats.decayed++;
        }
        catch {
            // Best-effort.
        }
    }
    for (const id of plan.delete) {
        try {
            await deps.store.delete(id);
            stats.deleted++;
        }
        catch {
            // Best-effort.
        }
    }
};
/**
 * Distil the finished transcript into durable records and persist them
 * (embed → consolidate → evict). Best-effort by contract: any failure in the
 * whole pipeline is swallowed — a session must never fail because memory did.
 */
export const persistSession = async (deps, input) => {
    const stats = emptyPersistStats();
    try {
        const records = await distillRecords(deps, input.finalMessages);
        stats.distilled = records.length;
        if (records.length === 0) {
            emitStats(deps.onStats, stats);
            return;
        }
        // C10: ONE store.all() snapshot for the whole persist. applyOp mirrors
        // every save/merge/supersede into it, so per-record dedup + the eviction
        // sweep below read the live in-memory mirror instead of re-scanning the
        // whole store O(records+1) times. Outcomes are unchanged (the mirror is
        // kept in lock-step with the store); only the scan count drops to 1.
        const snapshot = [...(await deps.store.all())];
        const now = (deps.now ?? Date.now)();
        for (const record of records) {
            const candidate = await buildCandidate(deps, input.sessionId, record, now);
            const dupes = findNearDuplicates(candidate, snapshot);
            const op = await decideOp(deps, candidate, dupes);
            await applyOp(deps.store, candidate, op, stats, snapshot);
        }
        await sweepEviction(deps, stats, snapshot, now);
        emitStats(deps.onStats, stats);
    }
    catch {
        // Persistence is advisory; never propagate. Still emit whatever was
        // counted before the failure (best-effort; emitStats never throws).
        emitStats(deps.onStats, stats);
    }
};
