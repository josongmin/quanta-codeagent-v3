// Memory slice domain types.
//
// @/llm-isolation workaround (RFC §3.1, biome.json src/memory/** override):
// the memory slice is forbidden from importing @/llm, yet two things must
// interoperate with it:
//
//  1. WorkingMemory must hold the same message objects the agent layer passes
//     around. Importing the concrete `Message` type would violate slice
//     isolation, so we declare a minimal *structural* shape (`StoredMessage`)
//     that the real llm `Message` is assignable to, and make WorkingMemory
//     generic over it.
//
//  2. Semantic recall needs embeddings, which only a provider (llm slice) can
//     produce. The memory slice therefore owns an injected {@link EmbedderPort}
//     interface; the concrete OpenAI implementation lives in @/agent (the only
//     cross-slice importer). Structural typing keeps both import-legal.
/** All valid {@link MemoryKind} values, for adapter validation / iteration. */
export const MEMORY_KINDS = ["fact", "decision", "observation", "preference"];
/** All valid {@link MemoryTier} values. */
export const MEMORY_TIERS = ["episodic", "semantic"];
/**
 * Embedding dimensionality. Matches OpenAI `text-embedding-3-small` (1536).
 * Stored vectors of a different length are treated as "no embedding" by the
 * ranking layer rather than throwing (model/version drift tolerance).
 */
export const EMBED_DIM = 1536;
/** Clamp helper (also maps NaN → `lo`). */
const clamp = (n, lo, hi) => Number.isNaN(n) ? lo : n < lo ? lo : n > hi ? hi : n;
/**
 * Apply documented defaults to an entry. Idempotent and pure. Called by every
 * adapter on the `save` / `recall` boundary so the rest of the slice (and
 * @/agent) can treat the optional fields as always-present.
 *
 * Defaults: `tier="semantic"`, `importance=0.5` (clamped to [0,1]),
 * `updatedAt=createdAt`, `accessCount=0` (clamped ≥0, integer). An `embedding`
 * whose length ≠ {@link EMBED_DIM} is dropped.
 */
export const normalizeEntry = (e) => {
    const createdAt = Number.isFinite(e.createdAt) ? e.createdAt : 0;
    const embedding = e.embedding && e.embedding.length === EMBED_DIM ? e.embedding : undefined;
    const out = {
        ...e,
        kind: MEMORY_KINDS.includes(e.kind) ? e.kind : "observation",
        tier: e.tier && MEMORY_TIERS.includes(e.tier) ? e.tier : "semantic",
        tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [],
        importance: clamp(e.importance ?? 0.5, 0, 1),
        createdAt,
        updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : createdAt,
        accessCount: Math.max(0, Math.floor(e.accessCount ?? 0)) || 0,
    };
    // Drop a wrong-length / absent embedding entirely (exactOptionalPropertyTypes:
    // an explicit `embedding: undefined` is not assignable to `embedding?:`).
    if (embedding)
        out.embedding = embedding;
    else
        delete out.embedding;
    return out;
};
/** age \<= this → `fresh` (1 hour). */
export const FRESH_MAX_MS = 60 * 60 * 1000;
/** age \<= this → `recent` (24 hours). */
export const RECENT_MAX_MS = 24 * 60 * 60 * 1000;
/** age \<= this → `stale` (30 days). */
export const STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Pure mapping of an age (ms) to its {@link FreshnessBucket}.
 * NaN / negative ages clamp to 0 (`fresh`); +Infinity → `archived`.
 */
export const bucketOf = (ageMs) => {
    if (Number.isNaN(ageMs) || ageMs <= 0)
        return "fresh";
    if (ageMs <= FRESH_MAX_MS)
        return "fresh";
    if (ageMs <= RECENT_MAX_MS)
        return "recent";
    if (ageMs <= STALE_MAX_MS)
        return "stale";
    return "archived";
};
/** Default {@link MemoryQuery.limit}. */
export const DEFAULT_RECALL_LIMIT = 20;
