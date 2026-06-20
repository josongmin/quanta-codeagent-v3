/**
 * Oracle-free impacted repo-test discovery for verify-and-select.
 *
 * This module is deliberately test-set provenance agnostic: it receives changed
 * source files plus a repository file snapshot and returns existing repo tests
 * that are likely to exercise those files. It does not know any SWE-bench hidden
 * fields; gold regression sets remain eval-only adapter concerns.
 */

export interface RepoTextFile {
  readonly path: string
  readonly text: string
}

export interface ImpactedTestCandidate {
  readonly path: string
  readonly score: number
  readonly reasons: readonly string[]
}

export interface DiscoverImpactedTestsArgs {
  readonly changedFiles: readonly string[]
  readonly repoFiles: readonly RepoTextFile[]
  readonly maxTests?: number
}

const DEFAULT_MAX_TESTS = 12

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

const scoreTestForSource = (
  testPath: string,
  testText: string,
  sourcePath: string,
): ImpactedTestCandidate | null => {
  const reasons: string[] = []
  let score = 0

  const sourceStem = stemOf(sourcePath)
  const testStem = stripTestAffixes(stemOf(testPath))
  if (sourceStem !== "" && sourceStem === testStem) {
    score += 50
    reasons.push(`mirror:${sourceStem}`)
  }

  const sourceParts = moduleParts(sourcePath)
  const sourcePkg = sourceParts[0]
  if (sourcePkg !== undefined && normalizeRepoPath(testPath).split("/").includes(sourcePkg)) {
    score += 5
    reasons.push(`package:${sourcePkg}`)
  }

  for (const re of importRegexesForSource(sourcePath)) {
    if (re.test(testText)) {
      score += 30
      reasons.push("import-ref")
      break
    }
  }

  return score > 0 ? { path: normalizeRepoPath(testPath), score, reasons } : null
}

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
      const scored = scoreTestForSource(path, file.text, source)
      if (scored === null) continue
      const prev = byPath.get(path)
      if (prev === undefined) {
        byPath.set(path, scored)
      } else {
        byPath.set(path, {
          path,
          score: prev.score + scored.score,
          reasons: [...new Set([...prev.reasons, ...scored.reasons])],
        })
      }
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxTests)
}

export const discoverImpactedTests = (args: DiscoverImpactedTestsArgs): string[] =>
  discoverImpactedTestCandidates(args).map((c) => c.path)
