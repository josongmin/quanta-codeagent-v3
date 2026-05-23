// Shared, pure recall ranking. Both InMemoryStore and SqliteStore reuse this
// so ranking semantics never diverge (RFC: "no logic duplication").
//
// Hybrid signal: a query embedding (when present) is the dominant term, so
// recall is robust to paraphrase — a text miss no longer kills a vector hit.
// Lexical / tag / freshness / importance / access reinforcement refine within.
import { bucketOf, DEFAULT_RECALL_LIMIT, EMBED_DIM, normalizeEntry, } from "./types";
import { cosine } from "./vector";
/** Vector similarity weight. Dominant signal — drives paraphrase-robust recall. */
const W_VEC = 10;
/** Points for a case-insensitive text substring hit. */
const W_TEXT = 5;
/** Extra points when entry text equals the query text exactly (whole-string). */
const W_TEXT_EXACT = 1;
/** Points per overlapping query tag. */
const W_TAG = 4;
/** Importance multiplier ([0,1] importance → up to this many points). */
const W_IMPORTANCE = 4;
/** Cap on the access-reinforcement bonus (log1p(accessCount) clamped here). */
const ACCESS_CAP = 3;
/** Tier-weight multiplier (durable semantic knowledge outranks raw episodic recap). */
const W_TIER = 2;
/**
 * Tier contribution to score, by tier. Semantic (distilled, durable knowledge)
 * ranks above episodic (raw per-session recap) when all else ties — final
 * points = `TIER_WEIGHT[tier] * W_TIER`.
 */
const TIER_WEIGHT = {
    semantic: 1,
    episodic: 0.5,
};
/** Freshness contribution to score, by bucket. Fresher ranks higher. */
const FRESHNESS_WEIGHT = {
    fresh: 3,
    recent: 2,
    stale: 1,
    archived: 0,
};
const lc = (s) => s.toLowerCase();
/**
 * Hard filters. `query.text` is NO LONGER a hard filter (it only scores) —
 * this removes the old paraphrase-kills-recall bug. `query.tags` IS still a
 * hard filter (≥1 tag overlap required when provided); `want` is the query's
 * precomputed lower-cased tag set (built once by the caller — see
 * {@link tagWantSet} — so the filter does not rebuild it per candidate).
 */
const passesFilters = (e, query, now, want) => {
    if (e.supersededBy && !query.includeSuperseded)
        return false;
    if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(e.kind)) {
        return false;
    }
    if (query.tiers && query.tiers.length > 0 && !query.tiers.includes(e.tier)) {
        return false;
    }
    if (want.size > 0 && !e.tags.some((t) => want.has(lc(t)))) {
        return false;
    }
    if (query.freshness &&
        query.freshness.length > 0 &&
        !query.freshness.includes(bucketOf(now - e.createdAt))) {
        return false;
    }
    if (typeof query.minImportance === "number" && e.importance < query.minImportance) {
        return false;
    }
    return true;
};
/** Clamped cosine contribution (0 unless both embeddings are full-dim). */
const vectorScore = (e, query) => {
    if (!query.embedding ||
        query.embedding.length !== EMBED_DIM ||
        !e.embedding ||
        e.embedding.length !== EMBED_DIM) {
        return 0;
    }
    const c = cosine(query.embedding, e.embedding);
    return (c < 0 ? 0 : c > 1 ? 1 : c) * W_VEC;
};
/** Lexical contribution: substring hit, plus exact whole-string bonus. */
const textScore = (e, query) => {
    if (!query.text || query.text.length === 0)
        return 0;
    const hay = lc(e.text);
    const needle = lc(query.text);
    if (!hay.includes(needle))
        return 0;
    return hay === needle ? W_TEXT + W_TEXT_EXACT : W_TEXT;
};
/** Lower-cased query-tag set. Depends ONLY on the query, so `rankEntries`
 *  builds it ONCE and threads it to every candidate's `tagScore` — building a
 *  fresh Set per candidate (recall runs every turn over 100+ candidates) was
 *  pure waste. */
const tagWantSet = (query) => new Set((query.tags ?? []).map(lc));
/** Tag-overlap contribution: W_TAG per shared (case-insensitive) tag. `want` is
 *  the precomputed query-tag set (see {@link tagWantSet}); counts overlap with
 *  no intermediate Set allocation. */
const tagScore = (e, want) => {
    if (want.size === 0)
        return 0;
    let overlap = 0;
    for (const t of e.tags)
        if (want.has(lc(t)))
            overlap++;
    return overlap * W_TAG;
};
/** Weighted-sum relevance score for an entry that passed the filters. `want` is
 *  the query's precomputed tag set (caller hoists it out of the candidate loop). */
const scoreOf = (e, query, now, want) => vectorScore(e, query) +
    textScore(e, query) +
    tagScore(e, want) +
    FRESHNESS_WEIGHT[bucketOf(now - e.createdAt)] +
    e.importance * W_IMPORTANCE +
    Math.min(Math.log1p(e.accessCount), ACCESS_CAP) +
    TIER_WEIGHT[e.tier] * W_TIER;
/**
 * Pure, exported score-of-one helper (ADR-0082 memory_citation provenance).
 * Returns the SAME deterministic weighted-sum score `rankEntries` uses
 * internally, for callers that already received the ranked entries from
 * `PersistentStorePort.recall` and want to annotate them with the score that
 * placed them. Normalizes the entry on the way in so callers can pass either
 * a raw `MemoryEntry` (store boundary) or a `NormalizedEntry` (post-rank).
 */
export const scoreEntry = (entry, query, now = Date.now()) => scoreOf(normalizeEntry(entry), query, now, tagWantSet(query));
/**
 * Filter + rank a candidate list. Pure and deterministic. Operates on
 * normalized entries. Sort: score desc, then importance desc, then updatedAt
 * desc, then createdAt desc, then id desc (total + deterministic). `now` is
 * injectable for deterministic tests.
 */
export const rankEntries = (candidates, query, now = Date.now()) => {
    const limit = query.limit ?? DEFAULT_RECALL_LIMIT;
    if (limit <= 0)
        return [];
    // Build the query-tag set ONCE (it is candidate-independent), then score.
    const want = tagWantSet(query);
    const scored = candidates
        .map(normalizeEntry)
        .filter((e) => passesFilters(e, query, now, want))
        .map((entry) => ({ entry, score: scoreOf(entry, query, now, want) }));
    scored.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.entry.importance !== a.entry.importance) {
            return b.entry.importance - a.entry.importance;
        }
        if (b.entry.updatedAt !== a.entry.updatedAt) {
            return b.entry.updatedAt - a.entry.updatedAt;
        }
        if (b.entry.createdAt !== a.entry.createdAt) {
            return b.entry.createdAt - a.entry.createdAt;
        }
        return b.entry.id < a.entry.id ? -1 : b.entry.id > a.entry.id ? 1 : 0;
    });
    return scored.slice(0, limit).map((s) => s.entry);
};
