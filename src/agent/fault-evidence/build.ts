/**
 * T-201 — FaultEvidencePacket builder. PURE + deterministic + bounded + blind.
 * Merges stage-1 ranked files, issue-named files, and bounded LSP owner-resolve
 * into ranked owner candidates with provenance. Never reads hidden bench labels;
 * never emits raw source bodies. See {@link FaultEvidencePacket}.
 */
import { extractSymbols } from "@/agent/issue-hint/extract-symbols"
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

const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_MAX_SYMBOLS = 12
/** Score boosts: a file named in the issue or resolved by LSP go-to-def is a
 *  stronger owner signal than a bare stage-1 rank hit. */
const ISSUE_FILE_BOOST = 2
const OWNER_RESOLVE_BOOST = 3
/** A typed-relation static witness is a strong STRUCTURAL hint for localization
 *  and repair review, so it ranks above a bare LSP owner-resolve. Score stays
 *  advisory-only; it never becomes clean owner-admission authority by itself. */
const STATIC_WITNESS_BOOST = 4

export type { FaultEvidenceInput, FaultEvidencePacket } from "./types"

export const buildFaultEvidencePacket = (input: FaultEvidenceInput): FaultEvidencePacket => {
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const maxSymbols = input.maxSymbols ?? DEFAULT_MAX_SYMBOLS

  const allSymbols = extractSymbols(input.issueText)
  const issueSymbols = allSymbols.slice(0, maxSymbols)

  const byFile = new Map<string, FaultCandidate>()
  const bump = (file: string, score: number, source: FaultCandidateSource): void => {
    if (!file) return
    const cur = byFile.get(file)
    if (cur) {
      cur.score += score
      if (!cur.sources.includes(source)) cur.sources.push(source)
    } else {
      byFile.set(file, { file, score, sources: [source], symbols: [] })
    }
  }

  for (const f of input.stage1Files ?? []) bump(f.file, f.score, "stage1")
  for (const f of input.issueFiles ?? []) bump(f, ISSUE_FILE_BOOST, "issue-file")
  for (const o of input.ownerResolved ?? []) bump(o.file, OWNER_RESOLVE_BOOST, "owner-resolve")
  // SCAFF-03: typed-relation witness owners carry the `static-witness` source as
  // advisory structural evidence. Generic `{ file, forSymbol? }` records — the
  // bench adapter already digested the witness IR, so this stays bench-agnostic.
  for (const w of input.witnessOwners ?? []) bump(w.file, STATIC_WITNESS_BOOST, "static-witness")
  // attach resolved symbol names (bounded, names only) to their owner file
  for (const o of input.ownerResolved ?? []) {
    const c = byFile.get(o.file)
    if (c && o.forSymbol && !c.symbols.includes(o.forSymbol)) c.symbols.push(o.forSymbol)
  }
  for (const w of input.witnessOwners ?? []) {
    const c = byFile.get(w.file)
    if (c && w.forSymbol && !c.symbols.includes(w.forSymbol)) c.symbols.push(w.forSymbol)
  }

  const ranked = [...byFile.values()].sort(
    (a, b) => b.score - a.score || a.file.localeCompare(b.file),
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
