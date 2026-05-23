// Pure near-duplicate detection for consolidation (RFC §6.3, long-term memory).
// Before saving a new memory, the store asks: does an equivalent entry already
// exist? A match is semantic (cosine) OR lexical (token-Jaccard) — either is
// enough, so paraphrases and embedding-less rows both get caught. Returns only
// candidates; the caller decides merge/supersede.
import { normalizeEntry } from "./types";
import { cosine } from "./vector";
/** Conservative defaults — tuned to catch paraphrase without false merges. */
export const DEFAULT_DUPE_THRESHOLDS = {
    cosine: 0.86,
    lexical: 0.6,
};
/** Lowercased `\w+` tokens of a string, deduplicated. */
const tokenSet = (s) => {
    const m = s.toLowerCase().match(/\w+/g);
    return new Set(m ?? []);
};
/** Jaccard overlap of two token sets ([0,1]; 0 when both empty). */
const jaccard = (a, b) => {
    if (a.size === 0 && b.size === 0)
        return 0;
    let inter = 0;
    for (const t of a)
        if (b.has(t))
            inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
};
/** Token-Jaccard plus cosine (0 unless both embeddings present) for one entry. */
const similarities = (cand, candTokens, e) => {
    const hasEmb = Boolean(cand.embedding && e.embedding);
    return {
        cos: hasEmb ? cosine(cand.embedding, e.embedding) : 0,
        lex: jaccard(candTokens, tokenSet(e.text)),
        hasEmb,
    };
};
/**
 * Best similarity if `e` is a near-duplicate of the candidate, else `null`.
 * Match if cosine OR token-Jaccard clears its threshold.
 */
const matchSim = (cand, candTokens, e, t) => {
    const { cos, lex, hasEmb } = similarities(cand, candTokens, e);
    const cosHit = hasEmb && cos >= t.cosine;
    const lexHit = lex >= t.lexical;
    if (!cosHit && !lexHit)
        return null;
    return Math.max(cosHit ? cos : 0, lexHit ? lex : 0);
};
/**
 * Find entries that are near-duplicates of `candidate`. Pure. Excludes the
 * candidate itself (by id) and any superseded entry. Match if cosine OR
 * token-Jaccard clears its threshold. Sorted by best similarity (max of the
 * two normalized scores) desc, then createdAt desc, then id desc.
 */
export const findNearDuplicates = (candidate, entries, thresholds) => {
    const t = { ...DEFAULT_DUPE_THRESHOLDS, ...thresholds };
    const cand = normalizeEntry(candidate);
    const candTokens = tokenSet(cand.text);
    const matches = [];
    for (const raw of entries) {
        const e = normalizeEntry(raw);
        if (e.id === cand.id)
            continue;
        if (e.supersededBy)
            continue;
        const sim = matchSim(cand, candTokens, e, t);
        if (sim === null)
            continue;
        matches.push({ e, sim });
    }
    matches.sort((a, b) => {
        if (b.sim !== a.sim)
            return b.sim - a.sim;
        if (b.e.createdAt !== a.e.createdAt)
            return b.e.createdAt - a.e.createdAt;
        return b.e.id < a.e.id ? -1 : b.e.id > a.e.id ? 1 : 0;
    });
    return matches.map((m) => m.e);
};
