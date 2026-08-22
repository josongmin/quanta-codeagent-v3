/**
 * PMX-02 — the ONE deterministic NESTED sample family.
 *
 * Packet invariant 8: *"`PMX-7 ⊂ PMX-14 ⊂ PMX-40 ⊂ PMX-170` is one deterministic
 * nested sample family, not four independently chosen samples."* Four
 * independently drawn samples would make every cross-sample comparison a
 * different population, so a canary that looked good would tell you nothing
 * about the run above it.
 *
 * ## The algorithm
 *
 * For each instance compute a stable ordering key
 *
 *     sha256( algorithm_version \0 dataset_revision \0 seed \0 language \0 instance_id )
 *
 * sort WITHIN each language by that key with a BYTEWISE instance-id tie-break,
 * and take a PREFIX of each language's ordered list. Nesting is then structural,
 * not checked-after-the-fact: quotas are non-decreasing across the family, and a
 * prefix of a prefix of a fixed list is always a subset. Determinism is likewise
 * structural — there is no RNG, no clock, no map-iteration dependence.
 *
 * `algorithm_version` and `seed` are INSIDE the hashed tuple, so changing either
 * genuinely re-draws the sample (and therefore changes every manifest digest)
 * rather than merely relabelling the same draw. A future v2 algorithm gets a new
 * version string and old campaign manifests keep meaning what they said.
 *
 * ## Why this is not `sampler.ts`
 *
 * `src/apps/bench/sampler.ts` selects among Best-of-N ATTEMPTS for one instance.
 * This selects a SUBSET of the dataset. Same word, unrelated concerns; merging
 * them would couple campaign scoping to candidate ranking. The operator command
 * and the runtime both import THIS module, so there is still exactly one
 * implementation of ordering and quota logic.
 */
import { byteCompare } from "@/shared"
import { sha256Hex } from "../provenance"
import { canonicalJson } from "./artifacts"

/** Bump ONLY together with a deliberate change to the ordering rule. */
export const PROMAX_SAMPLE_ALGORITHM_VERSION = "promax-sample/v1"

/** The default campaign seed. Recorded in every manifest, never implicit. */
export const PROMAX_DEFAULT_SAMPLE_SEED = "promax-v1"

/** Identity + language of one instance. Sampling needs NOTHING else — in
 *  particular it never touches gold, so a sample plan can be produced from the
 *  PUBLIC artifact alone. */
export interface ProMaxSampleCandidate {
  readonly instanceId: string
  readonly language: string
}

export interface ProMaxSampleManifest {
  /** `PMX-7`, `PMX-14`, `PMX-40`, `PMX-170`. */
  readonly name: string
  readonly algorithmVersion: string
  readonly datasetRevision: string
  readonly seed: string
  /** Per-language counts this sample actually contains. */
  readonly languageQuotas: Readonly<Record<string, number>>
  /** The selected ids, in the algorithm's global order. */
  readonly instanceIds: readonly string[]
  /** The digest of the sample this one CONTAINS, or null for the smallest. */
  readonly parentSubsetSha256: string | null
  /** sha256 over the canonical form of every field above. */
  readonly sha256: string
}

export class ProMaxSampleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProMaxSampleError"
  }
}

const orderingKey = (args: {
  readonly algorithmVersion: string
  readonly datasetRevision: string
  readonly seed: string
  readonly language: string
  readonly instanceId: string
}): string =>
  sha256Hex(
    // NUL-joined: no component can contain a NUL, so two different tuples can
    // never serialize to the same string (a `-` or `:` separator would let a
    // language and an instance id straddle the boundary).
    [args.algorithmVersion, args.datasetRevision, args.seed, args.language, args.instanceId].join(
      "\u0000",
    ),
  )

interface OrderedCandidate extends ProMaxSampleCandidate {
  readonly key: string
}

/** Total order over candidates: hash key first, bytewise id as the tie-break. */
const compareCandidates = (a: OrderedCandidate, b: OrderedCandidate): number => {
  const byKey = byteCompare(a.key, b.key)
  return byKey !== 0 ? byKey : byteCompare(a.instanceId, b.instanceId)
}

export interface ProMaxSampleSpec {
  readonly name: string
  /**
   * Per-language quota. `"all"` takes every instance of every language — the
   * PMX-170 case, expressed as a quota rather than as a special case so the
   * nesting proof does not need an exception.
   */
  readonly quotas: Readonly<Record<string, number>> | "all"
  /** Uniform quota shorthand (PMX-7 = 1 per language, PMX-14 = 2 per language). */
  readonly perLanguage?: number
}

/** The ticket's sample family, in nesting order. */
export const PROMAX_SAMPLE_SPECS: readonly ProMaxSampleSpec[] = [
  { name: "PMX-7", quotas: {}, perLanguage: 1 },
  { name: "PMX-14", quotas: {}, perLanguage: 2 },
  {
    name: "PMX-40",
    quotas: { c: 5, "c++": 5, go: 5, java: 6, python: 7, rust: 5, typescript: 7 },
  },
  { name: "PMX-170", quotas: "all" },
]

export interface BuildProMaxSampleFamilyInput {
  readonly candidates: readonly ProMaxSampleCandidate[]
  readonly datasetRevision: string
  readonly seed?: string
  readonly algorithmVersion?: string
  readonly specs?: readonly ProMaxSampleSpec[]
}

/** Group + order candidates by language. Pure and total. */
const orderByLanguage = (
  candidates: readonly ProMaxSampleCandidate[],
  algorithmVersion: string,
  datasetRevision: string,
  seed: string,
): Map<string, OrderedCandidate[]> => {
  const byLanguage = new Map<string, OrderedCandidate[]>()
  for (const candidate of candidates) {
    const ordered: OrderedCandidate = {
      ...candidate,
      key: orderingKey({ algorithmVersion, datasetRevision, seed, ...candidate }),
    }
    const bucket = byLanguage.get(candidate.language)
    if (bucket === undefined) byLanguage.set(candidate.language, [ordered])
    else bucket.push(ordered)
  }
  for (const bucket of byLanguage.values()) bucket.sort(compareCandidates)
  return byLanguage
}

const resolveQuotas = (
  spec: ProMaxSampleSpec,
  byLanguage: ReadonlyMap<string, readonly OrderedCandidate[]>,
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [language, bucket] of byLanguage) {
    if (spec.quotas === "all") {
      out[language] = bucket.length
      continue
    }
    const declared = spec.quotas[language] ?? spec.perLanguage
    if (declared === undefined) {
      throw new ProMaxSampleError(
        `promax sample ${spec.name}: the quota table does not cover language "${language}" ` +
          `(corpus has ${bucket.length} such instance(s)). REFUSING to silently drop a language ` +
          "from a stratified sample — declare its quota or use a different spec.",
      )
    }
    if (declared > bucket.length) {
      throw new ProMaxSampleError(
        `promax sample ${spec.name}: quota for "${language}" is ${declared} but the corpus has ` +
          `only ${bucket.length} such instance(s). REFUSING to emit an under-filled sample.`,
      )
    }
    out[language] = declared
  }
  if (spec.quotas !== "all") {
    for (const language of Object.keys(spec.quotas)) {
      if (!byLanguage.has(language)) {
        throw new ProMaxSampleError(
          `promax sample ${spec.name}: quota declares language "${language}" but the corpus ` +
            "contains no such instance. REFUSING a sample plan that does not match the corpus.",
        )
      }
    }
  }
  return out
}

const manifestDigest = (manifest: Omit<ProMaxSampleManifest, "sha256">): string =>
  sha256Hex(canonicalJson(manifest))

/**
 * Build ONE sample manifest. Exported so an operator can materialize a single
 * named sample, but the nesting guarantee comes from
 * {@link buildProMaxSampleFamily} — a lone manifest has no parent to point at.
 */
export const buildProMaxSampleManifest = (
  input: BuildProMaxSampleFamilyInput & {
    readonly spec: ProMaxSampleSpec
    readonly parentSubsetSha256?: string | null
  },
): ProMaxSampleManifest => {
  const algorithmVersion = input.algorithmVersion ?? PROMAX_SAMPLE_ALGORITHM_VERSION
  const seed = input.seed ?? PROMAX_DEFAULT_SAMPLE_SEED
  const byLanguage = orderByLanguage(
    input.candidates,
    algorithmVersion,
    input.datasetRevision,
    seed,
  )
  const quotas = resolveQuotas(input.spec, byLanguage)
  const selected: OrderedCandidate[] = []
  for (const [language, bucket] of byLanguage) {
    selected.push(...bucket.slice(0, quotas[language] ?? 0))
  }
  selected.sort(compareCandidates)
  const withoutDigest = {
    name: input.spec.name,
    algorithmVersion,
    datasetRevision: input.datasetRevision,
    seed,
    languageQuotas: sortedQuotas(quotas),
    instanceIds: selected.map((c) => c.instanceId),
    parentSubsetSha256: input.parentSubsetSha256 ?? null,
  }
  return { ...withoutDigest, sha256: manifestDigest(withoutDigest) }
}

/** Stable key order so the manifest digest cannot depend on insertion order. */
const sortedQuotas = (quotas: Record<string, number>): Readonly<Record<string, number>> => {
  const out: Record<string, number> = {}
  for (const language of Object.keys(quotas).sort(byteCompare))
    out[language] = quotas[language] ?? 0
  return out
}

/**
 * Build the whole nested family, each manifest naming the digest of the one it
 * contains. Duplicate candidate ids are refused: a duplicated id would inflate a
 * quota and make `⊂` an accident.
 */
export const buildProMaxSampleFamily = (
  input: BuildProMaxSampleFamilyInput,
): readonly ProMaxSampleManifest[] => {
  const seen = new Set<string>()
  for (const candidate of input.candidates) {
    if (seen.has(candidate.instanceId)) {
      throw new ProMaxSampleError(
        `promax sample: duplicate candidate instance "${candidate.instanceId}" — ` +
          "REFUSING to draw a stratified sample from a corpus with duplicate ids.",
      )
    }
    seen.add(candidate.instanceId)
  }
  const specs = input.specs ?? PROMAX_SAMPLE_SPECS
  const out: ProMaxSampleManifest[] = []
  let parent: string | null = null
  for (const spec of specs) {
    const manifest = buildProMaxSampleManifest({ ...input, spec, parentSubsetSha256: parent })
    out.push(manifest)
    parent = manifest.sha256
  }
  return out
}
