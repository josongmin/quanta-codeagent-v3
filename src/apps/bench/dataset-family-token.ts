/**
 * The ONE dataset-family normalization owner (aug-22 audit HIGH-3 repair).
 *
 * Before this module there were TWO independent normalizations of the same
 * selector token:
 *   - `run-config.ts` trimmed + case-folded (`raw.trim().toLowerCase()`)
 *   - `dataset-family.ts` only case-folded (`raw.toLowerCase()`)
 * so `--dataset-family " pro"` validated as **Pro** at the composition root
 * (seeding the Pro preset and forwarding FAMILY=pro to the box) while
 * `readSwebenchTasks` / `buildPythonSwebench` / the dry-run label / the report
 * stamp all resolved **Verified** — degrading Pro rows to the `testCmd:"true"`
 * no-op. A split-brain that reads as a clean pass.
 *
 * This leaf module owns the family UNION, its registry, and the single
 * normalization function. Both resolvers (`resolveDatasetFamily`, the lenient
 * legacy one, and `parseDatasetFamilyOrThrow`, the fail-closed composition-root
 * one) delegate here, so they CANNOT disagree on which token names which family
 * — they differ only in what they do with a token this module rejects (default
 * vs throw), which is the documented fail-safe/fail-closed split.
 *
 * Leaf by construction: NO imports. Anything that needs the family type or the
 * normalization imports from here.
 */

/** The closed dataset-family union.
 *
 *  `promax` (PMX-01) is SWE-Bench-ProMax: a DIFFERENT corpus, prediction
 *  contract, evaluator, image set and result semantics from ScaleAI's `pro`, so
 *  it is a sibling family and never an alias — `pro` and `promax` share neither a
 *  grader nor a report partition (packet invariant 1). It is also NOT a benchmark
 *  SUITE: `benchmarkSuite: "promax"` stays refused by `benchmark-suite.ts`. */
export type DatasetFamily = "verified" | "live" | "pro" | "promax"

/** The BUILT-IN families. A new family is added HERE (and the
 *  `Record<DatasetFamily, …>` profile registry then fails to compile until it is
 *  registered there too). */
const BUILTIN_DATASET_FAMILIES: readonly DatasetFamily[] = [
  "verified",
  "live",
  "pro",
  "promax",
] as const

/** Every currently-KNOWN selector token, seeded from the built-ins. Extended in
 *  lockstep with the profile registry (aug-22 HIGH-4): `registerDatasetFamilyProfile`
 *  calls {@link registerDatasetFamilyToken}, so a family that has a profile is
 *  exactly a family whose selector parses. A registry entry with no token (or a
 *  token with no profile) is the split-brain T4 exists to abolish. */
const KNOWN_TOKENS = new Set<string>(BUILTIN_DATASET_FAMILIES)

/** Registry of every known family, in registration order. Read by the error
 *  messages that list the valid selectors. */
export const DATASET_FAMILIES: readonly DatasetFamily[] = BUILTIN_DATASET_FAMILIES

/** All known selector tokens right now (built-ins + anything registered). */
export const knownDatasetFamilyTokens = (): readonly string[] => [...KNOWN_TOKENS]

/**
 * Register a NEW family selector token. Called by
 * `registerDatasetFamilyProfile` — never on its own, so the token universe and
 * the profile registry cannot drift apart. Returns a disposer.
 *
 * Leaf-safe: this module still imports nothing; the registry depends on it, not
 * the other way round.
 */
export const registerDatasetFamilyToken = (family: string): (() => void) => {
  const norm = family.trim().toLowerCase()
  if (norm === "" || norm !== family) {
    throw new Error(
      `bench: dataset family token "${family}" must be a non-empty, already-normalized ` +
        "(trimmed, lowercase) identifier.",
    )
  }
  KNOWN_TOKENS.add(norm)
  return () => {
    if (!BUILTIN_DATASET_FAMILIES.includes(norm as DatasetFamily)) KNOWN_TOKENS.delete(norm)
  }
}

/**
 * Normalize ONE raw selector token to its family, or `undefined` when the token
 * names no family (blank, whitespace-only, unknown, or a value with inner
 * whitespace like `"pr o"`).
 *
 * Semantics (explicit + covered by `family-authority.test.ts`):
 *  - surrounding whitespace is TRIMMED (`" pro"`, `"pro "`, `"\tPRO\n"` ⇒ pro)
 *  - matching is case-INSENSITIVE
 *  - nothing else is coerced: unknown stays unknown (the caller decides whether
 *    that defaults or throws).
 */
export const normalizeDatasetFamilyToken = (raw: string): DatasetFamily | undefined => {
  const norm = raw.trim().toLowerCase()
  return KNOWN_TOKENS.has(norm) ? (norm as DatasetFamily) : undefined
}
