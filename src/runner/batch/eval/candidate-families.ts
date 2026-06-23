/**
 * Candidate family generation surface (T-GEN-09).
 *
 * Replaces the single ranked owner list with family-separated candidate
 * generation so that a small symptom patch cannot consume the whole search
 * space before the root / API / lifecycle owner is explored.
 *
 * AUTHORITY (per `docs/plans/jun-21-heuristic-authority-cleanup`):
 *   Candidate families shape EXPLORATION + final TIE-BREAK only. They hold the
 *   `familyOrdering` authority class in the lattice — they have NO veto, NO
 *   score, NO admissibility power, and perform NO instance-specific pattern
 *   matching. The planner here is a PURE deterministic ordering function over
 *   an already-built bundle; it never inspects issue text, file paths, or
 *   patch contents.
 */

import { canBeCleanAuthority, canBeMultiSiteObligation, type StaticWitness } from "./static-witness"

/** Typed candidate-family identifiers. */
export type CandidateFamilyId =
  | "root-owner"
  | "symptom-owner"
  | "api-owner"
  | "lifecycle-owner"
  | "test-adjacent-owner"
  | "multi-site"
  // SCAFF-04 typed structural families from the static-witness adapter:
  | "override-family"
  | "producer-consumer"
  | "registration-callback"
  | "unique-owner"

/** Co-change families: a candidate must touch EVERY owner file to earn rank
 *  (an incomplete single-site patch in a co-change family scores 0). */
const COCHANGE_FAMILY_IDS: ReadonlySet<CandidateFamilyId> = new Set([
  "multi-site",
  "override-family",
  "producer-consumer",
  "registration-callback",
])

/**
 * A single candidate family: a set of owner files reached via the same
 * static-engine evidence path, with provenance for telemetry.
 */
export interface CandidateFamily {
  readonly familyId: CandidateFamilyId
  readonly ownerFiles: readonly string[]
  readonly reason: string
  readonly seed: string | undefined
  readonly sourceEvidence: readonly string[]
  /**
   * Producer endpoint of a DIRECTED structural relation (producer→consumer /
   * registration site→callback impl), when the source witness carried one. This
   * is real localization signal: "this file PRODUCES the symbol the other files
   * consume". `undefined` for undirected families (override-family, unique-owner).
   */
  readonly producerFile?: string
}

/** Bundle of candidate families produced by the static engine. */
export interface CandidateFamilyBundle {
  readonly families: readonly CandidateFamily[]
}

export interface SymbolOwnerWitness {
  readonly file: string
  readonly symbols: readonly string[]
}

export interface OwnerResolvedWitness {
  readonly file: string
  readonly forSymbol: string
  /** Optional source owner that led to this resolved co-change site. */
  readonly fromFile?: string
}

/**
 * Fixed deterministic precedence for family round-robin.
 *
 * This is the STABLE ordering authority: root-owner is explored before a
 * symptom-owner family can be reused, so a symptom patch cannot monopolize the
 * search space. Ordering is fixed across runs; original bundle order is the
 * final tie-break (see `orderNonEmptyFamilies`).
 */
const FAMILY_PRECEDENCE: readonly CandidateFamilyId[] = [
  // authoritative typed structural families first (force co-change coverage)
  "root-owner",
  "unique-owner",
  "override-family",
  "producer-consumer",
  "registration-callback",
  "api-owner",
  "lifecycle-owner",
  "multi-site",
  // advisory exploration families last
  "symptom-owner",
  "test-adjacent-owner",
] as const

const cleanList = (xs: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of xs) {
    const v = raw.trim()
    if (v === "" || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const hasAny = (xs: readonly string[], ys: ReadonlySet<string>): boolean =>
  xs.some((x) => ys.has(x))

export const isCoChangeFamily = (familyId: CandidateFamilyId): boolean =>
  COCHANGE_FAMILY_IDS.has(familyId)

/**
 * Files still missing from this candidate's structural family coverage.
 *
 * This is deliberately a pure structural check over typed family evidence and
 * touched files. It does not inspect issue text, benchmark ids, hidden tests, or
 * path-specific case rules.
 */
export const candidateFamilyCoverageMissing = (
  family: Pick<CandidateFamily, "familyId" | "ownerFiles"> | undefined,
  touchedFiles: readonly string[],
): string[] => {
  if (family === undefined) return []
  const ownerFiles = cleanList(family.ownerFiles)
  if (ownerFiles.length === 0) return []
  const touched = new Set(touchedFiles)
  if (isCoChangeFamily(family.familyId)) return ownerFiles.filter((file) => !touched.has(file))
  return hasAny(ownerFiles, touched) ? [] : ownerFiles
}

export const candidateFamilyRank = (
  family: Pick<CandidateFamily, "familyId" | "ownerFiles"> | undefined,
  touchedFiles: readonly string[],
): number => {
  if (family === undefined) return 0
  const ownerFiles = cleanList(family.ownerFiles)
  if (ownerFiles.length === 0) return 0
  return candidateFamilyCoverageMissing(family, touchedFiles).length === 0 ? 1 : 0
}

export const seedForCandidateFamily = (family: CandidateFamily): string => {
  const files = cleanList(family.ownerFiles)
  const fileLine =
    files.length === 0
      ? ""
      : ` Candidate family owner files: ${files.map((file) => `\`${file}\``).join(", ")}.`
  const seedLine =
    family.seed === undefined || family.seed.trim() === ""
      ? ""
      : ` Static seed: ${family.seed.trim()}`
  const coverageLine =
    files.length === 0
      ? ""
      : isCoChangeFamily(family.familyId)
        ? ` Family coverage postcondition: if public source evidence confirms this family is relevant, the final patch must touch every family owner file listed above; if source evidence disproves this family, leave this candidate with no patch rather than producing a partial single-site patch.`
        : ` Family coverage postcondition: if public source evidence confirms this family is relevant, the final patch must touch at least one family owner file listed above; if source evidence disproves this family, leave this candidate with no patch rather than editing an unrelated file.`
  return `Explore the \`${family.familyId}\` candidate family.${fileLine}${seedLine}${coverageLine} Use this static witness only to choose where to inspect; edit only after confirming the root cause from public source evidence.`
}

export const seedForCandidateFamilyCoverageRepair = (
  family: CandidateFamily,
  missingFiles: readonly string[],
): string => {
  const missing = cleanList(missingFiles)
  const missingLine =
    missing.length === 0
      ? ""
      : ` Previous attempt missed required family owner files: ${missing
          .map((file) => `\`${file}\``)
          .join(", ")}.`
  return `${seedForCandidateFamily(family)}${missingLine} Regenerate this same candidate from the base tree and satisfy the family coverage postcondition, or produce no patch if public source evidence disproves the family.`
}

const rootOwnerFamilyOf = (rootOwnerFiles: readonly string[]): CandidateFamily | undefined => {
  const ownerFiles = cleanList(rootOwnerFiles)
  if (ownerFiles.length === 0) return undefined
  return {
    familyId: "root-owner",
    ownerFiles,
    reason: "root owner files from localization evidence",
    seed: undefined,
    sourceEvidence: ["localization-owner-files"],
  }
}

const addSymbolFile = (bySymbol: Map<string, Set<string>>, symbol: string, file: string): void => {
  const cleanSymbol = symbol.trim()
  const cleanFile = file.trim()
  if (cleanSymbol === "" || cleanFile === "") return
  const files = bySymbol.get(cleanSymbol) ?? new Set<string>()
  files.add(cleanFile)
  bySymbol.set(cleanSymbol, files)
}

const symbolFileMapOf = (args: {
  readonly symbolOwners?: readonly SymbolOwnerWitness[]
  readonly ownerResolved?: readonly OwnerResolvedWitness[]
}): Map<string, Set<string>> => {
  const bySymbol = new Map<string, Set<string>>()
  for (const owner of args.symbolOwners ?? []) {
    for (const symbol of owner.symbols) addSymbolFile(bySymbol, symbol, owner.file)
  }
  for (const resolved of args.ownerResolved ?? []) {
    addSymbolFile(bySymbol, resolved.forSymbol, resolved.file)
    if (resolved.fromFile !== undefined)
      addSymbolFile(bySymbol, resolved.forSymbol, resolved.fromFile)
  }
  return bySymbol
}

const multiSiteFamiliesOf = (bySymbol: ReadonlyMap<string, Set<string>>): CandidateFamily[] =>
  [...bySymbol.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([symbol, files]) => {
      const ownerFiles = [...files].sort()
      if (ownerFiles.length < 2) return []
      return [
        {
          familyId: "multi-site" as const,
          ownerFiles,
          reason: `shared public symbol \`${symbol}\` spans multiple owner files`,
          seed: `Cover every owner file defining \`${symbol}\` if the bug is in that override family.`,
          sourceEvidence: ["static-symbol-witness"],
        },
      ]
    })

export const buildCandidateFamilyBundleFromWitness = (args: {
  readonly rootOwnerFiles?: readonly string[]
  readonly symbolOwners?: readonly SymbolOwnerWitness[]
  readonly ownerResolved?: readonly OwnerResolvedWitness[]
}): CandidateFamilyBundle | undefined => {
  const root = rootOwnerFamilyOf(args.rootOwnerFiles ?? [])
  const families = [
    ...(root === undefined ? [] : [root]),
    ...multiSiteFamiliesOf(symbolFileMapOf(args)),
  ]
  if (families.length === 0) return undefined
  return { families }
}

/** Map a static-witness kind to a typed candidate family. */
const WITNESS_KIND_TO_FAMILY: Readonly<Record<StaticWitness["kind"], CandidateFamilyId>> = {
  "override-family": "override-family",
  "producer-consumer": "producer-consumer",
  "registration-callback": "registration-callback",
  "unique-symbol-definer": "unique-owner",
}

const directedProducerOf = (
  witness: StaticWitness,
  ownerFiles: readonly string[],
): string | undefined => {
  const producer = witness.fromFile?.trim()
  return producer !== undefined && producer !== "" && ownerFiles.includes(producer)
    ? producer
    : undefined
}

const staticWitnessSeedOf = (args: {
  readonly witness: StaticWitness
  readonly directed: string | undefined
  readonly ownerFiles: readonly string[]
}): string | undefined => {
  if (args.directed === undefined) return undefined
  const consumers = args.ownerFiles.filter((f) => f !== args.directed)
  const symbol = cleanList([...args.witness.subjectSymbols])[0]
  return `Directed ${args.witness.kind}: \`${args.directed}\` produces${
    symbol === undefined ? "" : ` \`${symbol}\``
  } consumed by ${consumers.map((f) => `\`${f}\``).join(", ")}. Fix the root cause at the producer, not only the consumption site.`
}

const familyFromStaticWitness = (witness: StaticWitness): CandidateFamily | undefined => {
  if (!canBeCleanAuthority(witness)) return undefined
  const familyId = WITNESS_KIND_TO_FAMILY[witness.kind]
  if (COCHANGE_FAMILY_IDS.has(familyId) && !canBeMultiSiteObligation(witness)) return undefined
  const ownerFiles = cleanList(witness.subjectFiles)
  if (ownerFiles.length === 0) return undefined
  // A6: CONSUME the directional edge (`fromFile`). When the witness carries a
  // producer endpoint that is one of the owner files, surface it structurally
  // (`producerFile` + producer-lead ordering) and bake the direction into the
  // model-facing seed, instead of discarding it into `witnessId` only.
  const directed = directedProducerOf(witness, ownerFiles)
  const orderedFiles =
    directed === undefined ? ownerFiles : [directed, ...ownerFiles.filter((f) => f !== directed)]
  return {
    familyId,
    ownerFiles: orderedFiles,
    reason: witness.reason,
    seed: staticWitnessSeedOf({ witness, directed, ownerFiles }),
    sourceEvidence: [`static-witness:${witness.provenance}`],
    ...(directed === undefined ? {} : { producerFile: directed }),
  }
}

/**
 * SCAFF-04: typed structural candidate families from the AST static-witness
 * adapter. Only AUTHORITATIVE witnesses (genuine relation provenance) become
 * families; co-change kinds need >=2 files. Advisory / single-file witnesses are
 * skipped — a family label alone has no authority, and `candidateFamilyRank`
 * still requires a candidate to touch every co-change file.
 */
export const staticWitnessesToFamilies = (witnesses: readonly StaticWitness[]): CandidateFamily[] =>
  witnesses
    .map((witness) => familyFromStaticWitness(witness))
    .filter((family): family is CandidateFamily => family !== undefined)

/** Merge static-witness families into an existing family bundle (dedup by
 *  familyId+files), so AST structural co-change families also seed generation. */
export const withStaticWitnessFamilies = (
  bundle: CandidateFamilyBundle | undefined,
  witnesses: readonly StaticWitness[],
): CandidateFamilyBundle | undefined => {
  const extra = staticWitnessesToFamilies(witnesses)
  if (extra.length === 0) return bundle
  const byKey = new Map<string, CandidateFamily>()
  for (const f of [...(bundle?.families ?? []), ...extra]) {
    const key = `${f.familyId}:${cleanList(f.ownerFiles).join("|")}`
    if (!byKey.has(key)) byKey.set(key, f)
  }
  return { families: [...byKey.values()] }
}

/** A family is non-empty iff it actually contributes at least one owner file. */
const isNonEmptyFamily = (family: CandidateFamily): boolean => family.ownerFiles.length > 0

/**
 * Deterministically order the non-empty families:
 *   1. fixed family precedence (FAMILY_PRECEDENCE),
 *   2. stable original bundle order as the final tie-break.
 *
 * Stable: families sharing a familyId keep their relative bundle order.
 */
const orderNonEmptyFamilies = (bundle: CandidateFamilyBundle): readonly CandidateFamily[] => {
  const withIndex = bundle.families
    .map((family, index) => ({ family, index }))
    .filter((entry) => isNonEmptyFamily(entry.family))

  const rankOf = (id: CandidateFamilyId): number => {
    const rank = FAMILY_PRECEDENCE.indexOf(id)
    // Unknown ids (should be unreachable given the typed union) sort last but
    // remain deterministic via the original-order tie-break.
    return rank === -1 ? FAMILY_PRECEDENCE.length : rank
  }

  return withIndex
    .slice()
    .sort((a, b) => {
      const byPrecedence = rankOf(a.family.familyId) - rankOf(b.family.familyId)
      if (byPrecedence !== 0) return byPrecedence
      return a.index - b.index
    })
    .map((entry) => entry.family)
}

/**
 * PURE family-separated ordering planner.
 *
 * Returns an array of up to `n` `CandidateFamily` references implementing the
 * COVERAGE GUARANTEE: emit at least one candidate from each non-empty family
 * before reusing any family — i.e. round-robin across the non-empty families in
 * the stable deterministic order above. A symptom-owner family therefore cannot
 * monopolize the plan before root-owner is explored.
 *
 * Degradation:
 *   - 0 non-empty families  -> empty plan.
 *   - 1 non-empty family    -> legacy single-family repetition (that family
 *     repeated up to `n` times).
 *
 * Determinism: identical input + `n` always yields a deep-equal plan.
 *
 * @param bundle  the candidate family bundle from the static engine.
 * @param n       maximum number of candidate slots to plan.
 */
export const planFamilyCoverage = (
  bundle: CandidateFamilyBundle,
  n: number,
): readonly CandidateFamily[] => {
  if (!Number.isFinite(n) || n <= 0) return []

  const ordered = orderNonEmptyFamilies(bundle)
  if (ordered.length === 0) return []

  const cap = Math.floor(n)
  const plan: CandidateFamily[] = []
  // Round-robin: pass `r` emits each family once, in stable order, before any
  // family is revisited in pass `r + 1`.
  while (plan.length < cap) {
    for (const family of ordered) {
      if (plan.length >= cap) break
      plan.push(family)
    }
  }
  return plan
}

/**
 * Convenience projection: the family-id plan, for telemetry / assertions where
 * only the family identity (not the full family object) is needed.
 */
export const planFamilyCoverageIds = (
  bundle: CandidateFamilyBundle,
  n: number,
): readonly CandidateFamilyId[] => planFamilyCoverage(bundle, n).map((family) => family.familyId)
