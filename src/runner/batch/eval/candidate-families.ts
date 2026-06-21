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

/** Typed candidate-family identifiers. */
export type CandidateFamilyId =
  | "root-owner"
  | "symptom-owner"
  | "api-owner"
  | "lifecycle-owner"
  | "test-adjacent-owner"
  | "multi-site"

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
  "root-owner",
  "api-owner",
  "lifecycle-owner",
  "multi-site",
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

const hasAll = (xs: readonly string[], ys: ReadonlySet<string>): boolean =>
  xs.every((x) => ys.has(x))

export const candidateFamilyRank = (
  family: Pick<CandidateFamily, "familyId" | "ownerFiles"> | undefined,
  touchedFiles: readonly string[],
): number => {
  if (family === undefined) return 0
  const ownerFiles = cleanList(family.ownerFiles)
  if (ownerFiles.length === 0) return 0
  const touched = new Set(touchedFiles)
  if (family.familyId === "multi-site" && !hasAll(ownerFiles, touched)) return 0
  if (family.familyId !== "multi-site" && !hasAny(ownerFiles, touched)) return 0
  return 1
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
  return `Explore the \`${family.familyId}\` candidate family.${fileLine}${seedLine} Use this static witness only to choose where to inspect; edit only after confirming the root cause from public source evidence.`
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
