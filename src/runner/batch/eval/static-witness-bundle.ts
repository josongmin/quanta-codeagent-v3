/**
 * Static witness bundle (T-LOC-05).
 *
 * Composes already-gathered STATIC evidence — owner files, definition/reference
 * sites, co-change candidates, witness-test candidates, candidate families —
 * into one typed, deduped, stably-ordered bundle.
 *
 * AUTHORITY LATTICE (from docs/plans/jun-21-heuristic-authority-cleanup):
 *
 *   static engine    = find where to look and what to test  ← THIS BUNDLE
 *   candidate families = force search-space coverage
 *   public contracts = express what must hold
 *   executable proof = decide what can veto or admit
 *   heuristic signals = observe-only or research-only
 *
 * This bundle is OBSERVE / GENERATION evidence ONLY. It is NEVER verdict
 * authority. It deliberately carries:
 *   - NO veto / reject field,
 *   - NO admissibility field,
 *   - NO score / weight / confidence number,
 *   - NO reference to any hidden bench label (FAIL_TO_PASS / PASS_TO_PASS /
 *     test_patch) and no instance-specific pattern-matching.
 *
 * `confidenceReason` is a free-text orientation string for telemetry only; it is
 * a label a human reads, never a number a gate consumes. The shape is closed at
 * exactly 9 fields so no caller can smuggle a reject/score through it (enforced
 * compile-time by the readonly interface and at runtime by the assembler, which
 * only emits these keys).
 *
 * PURE + deterministic — no fs / exec / LSP calls. All static evidence is
 * injected as plain data; gathering happens upstream (lsp_definition,
 * find_references, repo-map, closure/fault evidence).
 */

/** Static evidence ONLY. Carries no veto authority, no admissibility, no score. */
export interface StaticWitnessBundle {
  readonly ownerFiles: readonly string[]
  readonly ownerFamilies: readonly string[]
  readonly definitionSites: readonly string[]
  readonly referenceSites: readonly string[]
  readonly coChangeCandidates: readonly string[]
  readonly candidateTests: readonly string[]
  readonly candidateFamilies: readonly string[]
  readonly confidenceReason: string
  readonly truncated: boolean
}

/**
 * Raw injected static evidence. Every list field is a plain (possibly unsorted,
 * possibly duplicate-bearing) array of strings gathered upstream. The assembler
 * is responsible for normalization; callers pass evidence as-is.
 */
export interface StaticWitnessEvidence {
  readonly ownerFiles?: readonly string[]
  readonly ownerFamilies?: readonly string[]
  readonly definitionSites?: readonly string[]
  readonly referenceSites?: readonly string[]
  readonly coChangeCandidates?: readonly string[]
  readonly candidateTests?: readonly string[]
  readonly candidateFamilies?: readonly string[]
  readonly confidenceReason?: string
  readonly truncated?: boolean
}

/**
 * Normalize a string evidence list: trim, drop empties, dedupe, stable sort.
 *
 * Stable order = lexicographic. This makes the bundle deterministic regardless
 * of the (LSP / walk / map) order the evidence happened to arrive in, which is
 * important because the bundle feeds candidate-family / witness generation and
 * telemetry — none of which should depend on incidental gather order.
 */
const normalizeList = (xs: readonly string[] | undefined): readonly string[] => {
  if (!xs || xs.length === 0) return []
  const seen = new Set<string>()
  for (const raw of xs) {
    const v = raw.trim()
    if (v.length > 0) seen.add(v)
  }
  return [...seen].sort()
}

/**
 * PURE assembler: compose injected static evidence into a typed
 * {@link StaticWitnessBundle}.
 *
 * - dedupes + stably orders every list (no dupes, lexicographic),
 * - empty / absent evidence yields an empty bundle (never throws),
 * - preserves the `truncated` flag verbatim (a find_references cap hit records
 *   truncation here — it is evidence, NOT a reject),
 * - emits ONLY the 9 closed fields, so no reject/score can ride along.
 */
export const buildStaticWitnessBundle = (
  evidence: StaticWitnessEvidence = {},
): StaticWitnessBundle => ({
  ownerFiles: normalizeList(evidence.ownerFiles),
  ownerFamilies: normalizeList(evidence.ownerFamilies),
  definitionSites: normalizeList(evidence.definitionSites),
  referenceSites: normalizeList(evidence.referenceSites),
  coChangeCandidates: normalizeList(evidence.coChangeCandidates),
  candidateTests: normalizeList(evidence.candidateTests),
  candidateFamilies: normalizeList(evidence.candidateFamilies),
  confidenceReason: evidence.confidenceReason?.trim() ?? "",
  truncated: evidence.truncated === true,
})
