/**
 * Oracle-free impacted repo-test discovery for verify-and-select.
 *
 * This module is deliberately test-set provenance agnostic: it receives changed
 * source files plus a repository file snapshot and returns existing repo tests
 * that are likely to exercise those files. It does not know any SWE-bench hidden
 * fields; gold regression sets remain eval-only adapter concerns.
 *
 * ── Authority split (T-REG-03) ──────────────────────────────────────────────
 * This file is the STATIC `WitnessTestCandidateBuilder`. It answers exactly one
 * question: "given the changed source, which existing repo tests are plausibly
 * worth EXECUTING as regression witnesses, and in what order?" It has NO verdict
 * authority. A candidate's *admissibility* (whether it is a witness at all) is
 * decided by the PRESENCE of structural evidence (mirror / import-ref / …), not
 * by any numeric score. The score table below is ORDERING-ONLY: it sorts the
 * already-admissible witnesses so the strongest run first under `maxTests`, and
 * it is surfaced in telemetry. Whether a candidate is rejected is decided later,
 * and ONLY by actually executing the selected tests (see
 * `repo-regression-discovery-adapter.ts` → `ExecutedWitnessResult`). Changing a
 * rank weight here can reorder which witnesses run first, but it can never, by
 * itself, turn a passing candidate into a rejected one.
 */

export interface RepoTextFile {
  readonly path: string
  readonly text: string
}

/**
 * Why a test was admitted as a witness for a changed source file. This is the
 * structural evidence — the thing that makes the test a candidate AT ALL. It is
 * recorded for telemetry and is independent of the ordering score.
 */
export type WitnessEvidenceKind =
  | "mirror"
  | "parent-mirror"
  | "import-ref"
  | "path-token"
  | "context-token"
  | "package"

export interface WitnessEvidence {
  readonly kind: WitnessEvidenceKind
  /** The matched token / module fragment (telemetry-visible provenance). */
  readonly detail: string
}

export interface ImpactedTestCandidate {
  readonly path: string
  /**
   * ORDERING-ONLY rank. Higher = earlier in the run order under `maxTests`. This
   * value carries NO verdict authority — it never decides admissibility and is
   * never compared against a threshold to reject a candidate. It exists so the
   * strongest structural witnesses execute first, and so telemetry can show the
   * ranking. See module header.
   */
  readonly score: number
  /** Backward-compatible flat reason strings (telemetry). */
  readonly reasons: readonly string[]
  /** Structural evidence that admitted this test (the real admissibility cause). */
  readonly evidence: readonly WitnessEvidence[]
}

export interface DiscoverImpactedTestsArgs {
  readonly changedFiles: readonly string[]
  readonly repoFiles: readonly RepoTextFile[]
  readonly maxTests?: number
  /** #6: invoked when the `maxTests` cap DROPS lower-ranked admissible witnesses
   *  from the executed set. The drop is otherwise INVISIBLE — and unlike the
   *  header's "can't reject a passing candidate" safety claim, a dropped witness
   *  can let a REGRESSING candidate pass (its breaking test never runs). The
   *  caller surfaces `{discovered, executed}` (e.g. into regression-gate
   *  telemetry / a log) so capped coverage is attributable, never a silent gap. */
  readonly onCap?: (info: { readonly discovered: number; readonly executed: number }) => void
}

export const DEFAULT_MAX_TESTS = 12

/**
 * ── ORDERING-ONLY rank weights ──────────────────────────────────────────────
 * These constants ONLY break ties when sorting already-admissible witnesses so
 * the strongest run first under `maxTests`. They are NOT a verdict gate: no code
 * path compares a candidate's accumulated score against a threshold to admit or
 * reject it. Admission is keyed on the PRESENCE of evidence (see
 * `evidenceForTestSource`); rejection is keyed on an EXECUTED test failing.
 * Tuning any weight below can change run order but can never, on its own, flip a
 * candidate from admitted to rejected.
 */
const RANK_WEIGHTS = {
  mirror: 50,
  parentMirror: 32,
  importRef: 30,
  pathToken: 18,
  contextToken: 8,
  package: 5,
} as const

/** ORDERING-ONLY: tokens shorter than this are too generic to rank on. */
const MIN_DISCOVERY_TOKEN_LENGTH = 4

export const normalizeRepoPath = (raw: string): string =>
  raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^(?:a|b)\//, "")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")

const basename = (path: string): string => path.split("/").at(-1) ?? path

const stemOf = (path: string): string => {
  const base = basename(path)
  const i = base.lastIndexOf(".")
  return i >= 0 ? base.slice(0, i) : base
}

const stripTestAffixes = (stem: string): string => stem.replace(/^test_/, "").replace(/_test$/, "")

const GENERIC_DISCOVERY_TOKENS = new Set([
  "app",
  "apps",
  "base",
  "common",
  "core",
  "helper",
  "helpers",
  "integration",
  "test",
  "tests",
  "unit",
  "util",
  "utils",
])

export const isPythonTestFile = (path: string): boolean => {
  const p = normalizeRepoPath(path)
  if (!p.endsWith(".py")) return false
  const base = basename(p)
  if (base === "__init__.py" || base === "conftest.py") return false
  const stem = stemOf(p)
  if (stem.startsWith("test_") || stem.endsWith("_test") || base === "tests.py") return true
  return p.split("/").includes("tests")
}

const isPythonSourceFile = (path: string): boolean => {
  const p = normalizeRepoPath(path)
  return p.endsWith(".py") && !isPythonTestFile(p)
}

const dropSourceRoots = (parts: readonly string[]): string[] => {
  const roots = new Set(["src", "lib", "python"])
  const out = [...parts]
  while (out.length > 1 && roots.has(out[0] as string)) out.shift()
  return out
}

const moduleParts = (path: string): string[] =>
  dropSourceRoots(normalizeRepoPath(path).replace(/\.py$/, "").split("/").filter(Boolean))

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const tokenizePath = (path: string): string[] =>
  normalizeRepoPath(path)
    .replace(/\.py$/, "")
    .split(/[/_.-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)

const isMeaningfulDiscoveryToken = (token: string): boolean =>
  token.length >= MIN_DISCOVERY_TOKEN_LENGTH && !GENERIC_DISCOVERY_TOKENS.has(token)

const importRegexesForSource = (source: string): RegExp[] => {
  const parts = moduleParts(source)
  if (parts.length === 0) return []
  const full = parts.join(".")
  const stem = parts[parts.length - 1] as string
  const parent = parts.slice(0, -1).join(".")
  const out: RegExp[] = [
    new RegExp(`\\bimport\\s+${escapeRegex(full)}(?:\\b|\\s+as\\s+)`),
    new RegExp(`\\bfrom\\s+${escapeRegex(full)}\\s+import\\b`),
  ]
  if (parent !== "") {
    out.push(
      new RegExp(
        `\\bfrom\\s+${escapeRegex(parent)}\\s+import\\s+[^\\n#]*\\b${escapeRegex(stem)}\\b`,
      ),
    )
  } else {
    out.push(new RegExp(`\\bimport\\s+${escapeRegex(stem)}(?:\\b|\\s+as\\s+)`))
    out.push(new RegExp(`\\bfrom\\s+${escapeRegex(stem)}\\s+import\\b`))
  }
  return out
}

/**
 * Collect the STRUCTURAL evidence that makes `testPath` a witness for
 * `sourcePath`. Returns an empty list when the test is NOT plausibly related —
 * an empty list is the real "not a candidate" signal (NOT a score of zero). The
 * caller turns presence-of-evidence into admissibility and uses the evidence
 * kinds only to compute an ordering rank.
 */
const evidenceForTestSource = (
  testPath: string,
  testText: string,
  sourcePath: string,
): WitnessEvidence[] => {
  const evidence: WitnessEvidence[] = []

  const sourceStem = stemOf(sourcePath)
  const testStem = stripTestAffixes(stemOf(testPath))
  if (sourceStem !== "" && sourceStem === testStem) {
    evidence.push({ kind: "mirror", detail: sourceStem })
  }

  const sourceParts = moduleParts(sourcePath)
  const sourcePkg = sourceParts[0]
  if (sourcePkg !== undefined && normalizeRepoPath(testPath).split("/").includes(sourcePkg)) {
    evidence.push({ kind: "package", detail: sourcePkg })
  }

  const sourceToken = sourceStem.toLowerCase()
  const testTokens = new Set(tokenizePath(testPath))
  if (isMeaningfulDiscoveryToken(sourceToken) && testTokens.has(sourceToken)) {
    evidence.push({ kind: "path-token", detail: sourceToken })
  }

  const contextTokens = [...new Set(sourceParts.slice(0, -1).flatMap((part) => tokenizePath(part)))]
  for (const token of contextTokens) {
    if (!isMeaningfulDiscoveryToken(token) || token === sourceToken || !testTokens.has(token))
      continue
    evidence.push({ kind: "context-token", detail: token })
  }

  const testParts = normalizeRepoPath(testPath).replace(/\.py$/, "").split("/").filter(Boolean)
  const testParent = testParts.at(-2)?.toLowerCase()
  if (
    basename(testPath) === "tests.py" &&
    testParent !== undefined &&
    testParent === sourceToken &&
    isMeaningfulDiscoveryToken(sourceToken)
  ) {
    evidence.push({ kind: "parent-mirror", detail: sourceToken })
  }

  for (const re of importRegexesForSource(sourcePath)) {
    if (re.test(testText)) {
      evidence.push({ kind: "import-ref", detail: moduleParts(sourcePath).join(".") })
      break
    }
  }

  return evidence
}

/**
 * ORDERING-ONLY: map a witness's structural evidence to a rank number. This is
 * the single place the magic weights are consumed, and it is a pure projection
 * of evidence → number. It is NEVER used as a gate (no threshold compare); it
 * only feeds the stable sort that decides run order under `maxTests`.
 */
export const rankWitnessEvidence = (evidence: readonly WitnessEvidence[]): number => {
  let rank = 0
  for (const e of evidence) {
    switch (e.kind) {
      case "mirror":
        rank += RANK_WEIGHTS.mirror
        break
      case "parent-mirror":
        rank += RANK_WEIGHTS.parentMirror
        break
      case "import-ref":
        rank += RANK_WEIGHTS.importRef
        break
      case "path-token":
        rank += RANK_WEIGHTS.pathToken
        break
      case "context-token":
        rank += RANK_WEIGHTS.contextToken
        break
      case "package":
        rank += RANK_WEIGHTS.package
        break
    }
  }
  return rank
}

/** Flat backward-compatible reason strings from typed evidence (telemetry). */
const reasonsFromEvidence = (evidence: readonly WitnessEvidence[]): string[] =>
  evidence.map((e) => (e.kind === "import-ref" ? "import-ref" : `${e.kind}:${e.detail}`))

const candidateForTestSource = (
  testPath: string,
  testText: string,
  sourcePath: string,
): ImpactedTestCandidate | null => {
  const evidence = evidenceForTestSource(testPath, testText, sourcePath)
  // Presence of structural evidence — NOT a numeric score — admits the witness.
  if (evidence.length === 0) return null
  return {
    path: normalizeRepoPath(testPath),
    score: rankWitnessEvidence(evidence),
    reasons: reasonsFromEvidence(evidence),
    evidence,
  }
}

/**
 * Static `WitnessTestCandidateBuilder`: build the admissible witness candidates
 * (presence-of-evidence) and ORDER them by rank for run-first-under-`maxTests`.
 * Returns no verdict — only the ordered candidate list + telemetry-visible
 * evidence/score. The decision to reject is made elsewhere, only after these
 * tests are actually executed.
 */
export const discoverImpactedTestCandidates = (
  args: DiscoverImpactedTestsArgs,
): ImpactedTestCandidate[] => {
  const maxTests = Math.max(1, Math.floor(args.maxTests ?? DEFAULT_MAX_TESTS))
  const sources = [...new Set(args.changedFiles.map(normalizeRepoPath).filter(isPythonSourceFile))]
  if (sources.length === 0) return []

  const byPath = new Map<string, ImpactedTestCandidate>()
  for (const file of args.repoFiles) {
    const path = normalizeRepoPath(file.path)
    if (!isPythonTestFile(path)) continue
    for (const source of sources) {
      const scored = candidateForTestSource(path, file.text, source)
      if (scored === null) continue
      const prev = byPath.get(path)
      if (prev === undefined) {
        byPath.set(path, scored)
      } else {
        const evidence = mergeEvidence(prev.evidence, scored.evidence)
        byPath.set(path, {
          path,
          score: rankWitnessEvidence(evidence),
          reasons: reasonsFromEvidence(evidence),
          evidence,
        })
      }
    }
  }

  // ORDERING-ONLY sort: rank desc, then path for determinism. Slicing by
  // `maxTests` bounds how many witnesses we will actually execute.
  const ranked = [...byPath.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  )
  // #6: a strict truncation drops real, admissible witnesses from the executed
  // set with no other signal. Surface it so a capped regression gate is never a
  // silent coverage gap (a regressing candidate whose breaking test was capped
  // out would otherwise read as `regressionGreen`).
  if (ranked.length > maxTests) {
    args.onCap?.({ discovered: ranked.length, executed: maxTests })
  }
  return ranked.slice(0, maxTests)
}

/** Merge evidence from multiple changed sources for the same test, deduped. */
const mergeEvidence = (
  a: readonly WitnessEvidence[],
  b: readonly WitnessEvidence[],
): WitnessEvidence[] => {
  const seen = new Set<string>()
  const out: WitnessEvidence[] = []
  for (const e of [...a, ...b]) {
    const key = `${e.kind}:${e.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

export const discoverImpactedTests = (args: DiscoverImpactedTestsArgs): string[] =>
  discoverImpactedTestCandidates(args).map((c) => c.path)
