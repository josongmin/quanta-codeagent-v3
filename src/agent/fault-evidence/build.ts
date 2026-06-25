/**
 * T-201 — FaultEvidencePacket builder. PURE + deterministic + bounded + blind.
 * Merges stage-1 ranked files, issue-named files, and bounded LSP owner-resolve
 * into ranked owner candidates with provenance. Never reads hidden bench labels;
 * never emits raw source bodies. See {@link FaultEvidencePacket}.
 */
import { extractSymbols } from "@/agent/issue-hint/extract-symbols"
import { byteCompare } from "@/shared/byte-compare"
import type {
  FaultCandidate,
  FaultCandidateSource,
  FaultEvidenceInput,
  FaultEvidencePacket,
  OwnerStrength,
} from "./types"

export type { OwnerStrength } from "./types"

/**
 * T-OWN-12 / SCAFF-03 — PURE strength classifier (additive; reads only
 * `sources`, never `score`). A candidate is AUTHORITATIVE iff it carries an
 * authoritative PUBLIC evidence stream:
 *   - `issue-file` — named in public issue text.
 *
 * Structural static-witness provenance is still useful for localization and
 * repair evidence, but it is NOT, by itself, a clean owner-admission authority.
 * A bare `owner-resolve`, `stage1`, or `static-witness` stream therefore stays
 * ADVISORY here.
 */
const AUTHORITATIVE_SOURCES: readonly FaultCandidateSource[] = ["issue-file"]
export const ownerStrength = (candidate: Pick<FaultCandidate, "sources">): OwnerStrength =>
  candidate.sources.some((s) => AUTHORITATIVE_SOURCES.includes(s)) ? "authoritative" : "advisory"

/**
 * Sweepable DEFAULT candidate/symbol windows (domain: positive integers). These
 * are NOT frozen decision literals — both are overridable per-call via
 * `input.maxCandidates` / `input.maxSymbols`, which the bench adapter feeds from
 * the localize budget. They name a deliberate default window size only; they
 * carry NO ranking semantics (ranking is parameter-free, see TIER_ORDER below).
 */
const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_MAX_SYMBOLS = 12

/**
 * PARAMETER-FREE provenance TIER lattice (no magnitudes, no additive blend).
 *
 * Files rank by a LEXICOGRAPHIC tier ordering over their evidence provenance,
 * NOT by a sum of per-source boosts. A file's tier is its STRONGEST source
 * (the most owner-bearing stream that points at it) — so accumulating several
 * weak streams can never out-rank one strong stream. The relative order
 * (static-witness > owner-resolve > issue-file > stage1) is the same justified
 * order the old `*_BOOST` magnitudes encoded, but expressed as ordinal RANKS in
 * an explicit list rather than hand-picked numbers that admit additive blending.
 *
 * Strongest first. `strongestTier` returns the index (lower index = stronger),
 * so a file's effective rank is `min` over its sources' indices.
 */
const TIER_ORDER: readonly FaultCandidateSource[] = [
  "static-witness",
  "owner-resolve",
  "issue-file",
  "stage1",
]
const UNRANKED_TIER = TIER_ORDER.length
/** Strongest (lowest) tier index across a candidate's provenance streams. */
const strongestTier = (sources: readonly FaultCandidateSource[]): number => {
  let best = UNRANKED_TIER
  for (const s of sources) {
    const idx = TIER_ORDER.indexOf(s)
    if (idx >= 0 && idx < best) best = idx
  }
  return best
}

export type { FaultEvidenceInput, FaultEvidencePacket } from "./types"

export const buildFaultEvidencePacket = (input: FaultEvidenceInput): FaultEvidencePacket => {
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const maxSymbols = input.maxSymbols ?? DEFAULT_MAX_SYMBOLS

  const allSymbols = extractSymbols(input.issueText)
  const issueSymbols = allSymbols.slice(0, maxSymbols)

  const byFile = new Map<string, FaultCandidate>()
  // Merge a provenance stream into a file's candidate. NO additive arithmetic:
  // the only persisted numeric is the EXTERNALLY-SUPPLIED stage-1 rank score
  // (carried by MAX, never summed), used solely as a parameter-free tie-break
  // *within* a tier. Provenance streams without an external score (issue-file /
  // owner-resolve / static-witness) contribute a tier, not a magnitude.
  const mergeSource = (
    file: string,
    source: FaultCandidateSource,
    externalScore?: number,
  ): void => {
    if (!file) return
    const cur = byFile.get(file)
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source)
      if (externalScore !== undefined && externalScore > cur.score) cur.score = externalScore
    } else {
      byFile.set(file, { file, score: externalScore ?? 0, sources: [source], symbols: [] })
    }
  }

  for (const f of input.stage1Files ?? []) mergeSource(f.file, "stage1", f.score)
  for (const f of input.issueFiles ?? []) mergeSource(f, "issue-file")
  for (const o of input.ownerResolved ?? []) mergeSource(o.file, "owner-resolve")
  // SCAFF-03: typed-relation witness owners carry the `static-witness` source as
  // advisory structural evidence. Generic `{ file, forSymbol? }` records — the
  // bench adapter already digested the witness IR, so this stays bench-agnostic.
  for (const w of input.witnessOwners ?? []) mergeSource(w.file, "static-witness")
  // attach resolved symbol names (bounded, names only) to their owner file
  for (const o of input.ownerResolved ?? []) {
    const c = byFile.get(o.file)
    if (c && o.forSymbol && !c.symbols.includes(o.forSymbol)) c.symbols.push(o.forSymbol)
  }
  for (const w of input.witnessOwners ?? []) {
    const c = byFile.get(w.file)
    if (c && w.forSymbol && !c.symbols.includes(w.forSymbol)) c.symbols.push(w.forSymbol)
  }

  // PARAMETER-FREE ranking: lexicographic by (1) strongest provenance tier,
  // then (2) the external stage-1 rank score as an in-tier tie-break (NOT an
  // additive blend — a file present in several sets sorts by its strongest tier,
  // never by a sum), then (3) a stable path tie-break. Two weak signals can
  // never out-rank one strong signal: tier dominates the comparison.
  const ranked = [...byFile.values()].sort(
    (a, b) =>
      strongestTier(a.sources) - strongestTier(b.sources) ||
      b.score - a.score ||
      byteCompare(a.file, b.file),
  )
  const candidates = ranked.slice(0, maxCandidates)

  return {
    candidates,
    issueSymbols,
    truncated: ranked.length > maxCandidates || allSymbols.length > maxSymbols,
    // partial when a blind input stream was absent: no stage-1 ranking, or LSP
    // owner-resolve was unavailable (undefined, distinct from "ran, found none").
    partial: (input.stage1Files?.length ?? 0) === 0 || input.ownerResolved === undefined,
  }
}
