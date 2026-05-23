/**
 * Maestro nickname pool (Cluster E / F17, ADR-0042).
 *
 * Source list — 39 ASCII-only, ≤ 12 char names drawn from classical
 * conductors and composers. The choice is deliberate: a stable, well-known
 * pool that survives translation across UI surfaces (terminal logs, web
 * dashboards, git commit attributions) without rendering hazards.
 *
 * Names are kept short for log alignment. None contain spaces or punctuation
 * other than the underlying alphabet.
 *
 * Source (closed list — extend only via an ADR amendment):
 *   conductors: Karajan, Bernstein, Solti, Toscanini, Furtwangler, Abbado,
 *               Muti, Mehta, Boulez, Rattle, Haitink, Levine, Ozawa,
 *               Barenboim, Klemperer
 *   composers:  Bach, Mozart, Beethoven, Brahms, Mahler, Chopin, Wagner,
 *               Verdi, Puccini, Schubert, Sibelius, Dvorak, Ravel, Debussy,
 *               Handel, Haydn, Strauss, Bizet, Berlioz, Liszt, Tchaikov,
 *               Stravinsk, Bartok, Rachman
 *
 * Slice contract: NO external imports, NO non-deterministic RNG, NO mutation.
 */
export const MAESTRO_NICKNAMES = Object.freeze([
    // Conductors (15) ────────────────────────────────────────────────────────
    "Karajan",
    "Bernstein",
    "Solti",
    "Toscanini",
    "Furtwangler",
    "Abbado",
    "Muti",
    "Mehta",
    "Boulez",
    "Rattle",
    "Haitink",
    "Levine",
    "Ozawa",
    "Barenboim",
    "Klemperer",
    // Composers (24) ─────────────────────────────────────────────────────────
    "Bach",
    "Mozart",
    "Beethoven",
    "Brahms",
    "Mahler",
    "Chopin",
    "Wagner",
    "Verdi",
    "Puccini",
    "Schubert",
    "Sibelius",
    "Dvorak",
    "Ravel",
    "Debussy",
    "Handel",
    "Haydn",
    "Strauss",
    "Bizet",
    "Berlioz",
    "Liszt",
    "Tchaikov",
    "Stravinsk",
    "Bartok",
    "Rachman",
]);
/** Defensive: enforce the invariants at import-time so a list edit can't
 *  silently break length or character constraints. Fails fast (Cluster E
 *  hard rule). */
const validatePool = () => {
    if (MAESTRO_NICKNAMES.length !== 39) {
        throw new Error(`MAESTRO_NICKNAMES must contain exactly 39 names; got ${MAESTRO_NICKNAMES.length}`);
    }
    const seen = new Set();
    for (const n of MAESTRO_NICKNAMES) {
        if (n.length === 0 || n.length > 12) {
            throw new Error(`maestro nickname '${n}' length out of bounds (must be 1..12)`);
        }
        if (!/^[A-Za-z][A-Za-z]*$/.test(n)) {
            throw new Error(`maestro nickname '${n}' must be ASCII letters only`);
        }
        if (seen.has(n)) {
            throw new Error(`maestro nickname '${n}' appears more than once`);
        }
        seen.add(n);
    }
};
validatePool();
/** FNV-1a 32-bit hash. Deterministic, dependency-free; avoids the platform-
 *  specific bias of `String.prototype.charCodeAt` arithmetic loops while
 *  staying ≤ 200 bytes of source. */
const fnv1a32 = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xff;
        // Math.imul to keep the multiply inside 32-bit signed range.
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
};
const seedToIndex = (seed) => {
    const s = typeof seed === "number" ? String(seed) : seed;
    return fnv1a32(s) % MAESTRO_NICKNAMES.length;
};
/** Deterministic seed → nickname. Same seed (string or number) yields the
 *  same name across processes and platforms. */
export const assignNickname = (seed) => {
    const idx = seedToIndex(seed);
    const name = MAESTRO_NICKNAMES[idx];
    if (name === undefined) {
        // Unreachable while the pool stays 39 long — but `noUncheckedIndexedAccess`
        // requires a guard. Treat as an invariant violation.
        throw new Error(`internal: nickname index ${idx} out of bounds`);
    }
    return name;
};
/** Pick the first nickname not already in `usedSet`. Returns `null` once the
 *  pool is fully exhausted — NO fallback / NO re-use (Cluster E hard rule). */
export const nextSequentialNickname = (usedSet) => {
    for (const n of MAESTRO_NICKNAMES) {
        if (!usedSet.has(n))
            return n;
    }
    return null;
};
