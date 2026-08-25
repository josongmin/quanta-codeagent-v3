/**
 * Derive the verification scope for a change, instead of guessing it.
 *
 * WHY THIS EXISTS. Three red landings in one session, three different causes,
 * none of them catchable by "run the tests next to what you touched":
 *
 *   - A staged set that was a SUBSET of the verified working tree (the tests
 *     passed against files that never went into the commit).
 *   - A repo-wide SCANNER guard (`audit-ratchet/`) that imports nothing, so no
 *     dependency analysis can point at it.
 *   - A snapshot test that mentions neither the changed file, its exports, nor
 *     its directory, and reaches it only THROUGH another module.
 *
 * So the scope is two sets, and both halves are load-bearing:
 *
 *   tests   — every test that TRANSITIVELY imports a changed file. Resolved
 *             through the real import graph because the third case above has
 *             zero textual overlap with what it guards.
 *   globals — the scanners, which read the filesystem rather than importing it.
 *             They always run; nothing about a diff can exclude them.
 *
 * Deliberately NOT a test runner. It prints paths; the caller runs them. That
 * keeps it usable from a hook, a script, or by hand, and keeps its own failure
 * mode ("printed too few paths") separate from a suite's.
 *
 * WHAT IT PROMISES, and what it does not. The contract is DO NOT MISS, not
 * "return a small set". Measured on this repo, a leaf module comes back with
 * ~240 of 3,730 test files while `src/storage/service.ts` comes back with
 * ~2,300 — and the second number is HONEST: barrel re-exports (`index.ts`
 * re-export walls) make most of the suite genuinely able to reach a core
 * module. Reading a large scope as a tool defect is the mistake; it is the real
 * blast radius, and knowing it beats guessing a directory and landing red.
 * Shrinking it means fewer barrels, not a cleverer resolver.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..")

/** Roots that hold shipped code or tests. `tools/` is included: its scripts back
 *  gates, and a broken one fails CI as surely as a broken `src/` module. */
const SCAN_ROOTS = ["src", "tests", "tools", "apps"] as const

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".cache",
  "__snapshots__",
  ".pristine-audit",
])

const isTestFile = (rel: string): boolean =>
  rel.endsWith(".test.ts") || rel.endsWith(".test.tsx") || rel.endsWith(".hellgate.test.ts")

/** Scanner guards: they read the tree instead of importing it, so the graph can
 *  never reach them and a diff can never exclude them. Matched on PATH so a new
 *  ratchet is picked up the day it lands, without an inventory to maintain. */
const isGlobalScanner = (rel: string): boolean =>
  isTestFile(rel) &&
  (rel.includes("ratchet") || rel.includes("audit-ratchet") || rel.includes("_arch/"))

const walk = (dir: string, out: string[]): void => {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    // Dot-directories are never shipped code, and at least one (`tools/dev/.scratch`)
    // holds COPIES of real modules — counting those would both inflate the graph
    // and report a scratch duplicate as the file to test.
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const abs = join(dir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(abs)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      walk(abs, out)
      continue
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(relative(REPO_ROOT, abs))
  }
}

const allSourceFiles = (): string[] => {
  const out: string[] = []
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), out)
  return out
}

/** Every module specifier a file imports (static, dynamic, and `export … from`).
 *  A regex is enough here because the ONLY thing that matters is the specifier
 *  string, and TypeScript cannot spell one that this misses without also being
 *  unreadable to the resolver below. */
const SPEC_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g

const specifiersOf = (rel: string): string[] => {
  let text: string
  try {
    text = readFileSync(join(REPO_ROOT, rel), "utf8")
  } catch {
    return []
  }
  const out: string[] = []
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = m[1]
    if (spec !== undefined) out.push(spec)
  }
  return out
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"] as const

/** Resolve one specifier to a repo-relative file, or null when it is a package
 *  (`node:fs`, `zod`) or something no candidate suffix names. `@/x` is the
 *  repo's `src/x` alias — the reason a purely textual search misses case 3 is
 *  that the alias hides the directory the guard actually lives in. */
const resolveSpecifier = (fromFile: string, spec: string, known: Set<string>): string | null => {
  const base = spec.startsWith("@/")
    ? join("src", spec.slice(2))
    : spec.startsWith(".")
      ? relative(REPO_ROOT, resolve(REPO_ROOT, dirname(fromFile), spec))
      : null
  if (base === null) return null
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (known.has(candidate)) return candidate
  }
  return null
}

export interface VerificationScope {
  /** Tests that transitively import at least one changed file. */
  readonly tests: readonly string[]
  /** Scanner guards, which always run. */
  readonly globals: readonly string[]
  /** Denominator for judging how selective the result is. */
  readonly totalTestFiles: number
}

/**
 * The tests that can observe `changed`, plus the scanners that always run.
 *
 * Walks the import graph BACKWARDS: build `importer → imported`, invert it, then
 * flood out from the changed files. Inversion rather than per-test forward
 * search because the graph is walked once for any number of changed files.
 */
export const deriveVerificationScope = (changed: readonly string[]): VerificationScope => {
  const files = allSourceFiles()
  const known = new Set(files)
  const testFiles = files.filter(isTestFile)

  // imported → importers
  const importedBy = new Map<string, string[]>()
  for (const file of files) {
    for (const spec of specifiersOf(file)) {
      const target = resolveSpecifier(file, spec, known)
      if (target === null || target === file) continue
      const list = importedBy.get(target)
      if (list === undefined) importedBy.set(target, [file])
      else list.push(file)
    }
  }

  // Flood outward from the changed set. A changed file that nothing imports is
  // still its own dependent, so a test file edited directly is in scope.
  const reached = new Set<string>()
  const queue = changed.filter((c) => known.has(c))
  for (const c of queue) reached.add(c)
  while (queue.length > 0) {
    const next = queue.pop() as string
    for (const importer of importedBy.get(next) ?? []) {
      if (reached.has(importer)) continue
      reached.add(importer)
      queue.push(importer)
    }
  }

  const tests = [...reached].filter(isTestFile).sort()
  const globals = testFiles.filter(isGlobalScanner).sort()
  return { tests, globals, totalTestFiles: testFiles.length }
}

/** CLI: `bun run tools/dev/verify-scope.ts [--staged | <file>…]`. Defaults to
 *  the STAGED set, because the defect this exists to stop was verifying the
 *  working tree and committing a subset of it. */
if (import.meta.main) {
  const argv = process.argv.slice(2)
  const explicit = argv.filter((a) => !a.startsWith("--"))
  let changed = explicit
  if (changed.length === 0) {
    const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: REPO_ROOT })
    changed = new TextDecoder()
      .decode(proc.stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  }
  if (changed.length === 0) {
    console.error("verify-scope: nothing staged (and no files given) — nothing to derive from.")
    process.exit(2)
  }
  const scope = deriveVerificationScope(changed)
  console.error(
    `verify-scope: ${changed.length} changed file(s) ⇒ ${scope.tests.length} dependent test(s) ` +
      `of ${scope.totalTestFiles} + ${scope.globals.length} always-run scanner(s)`,
  )
  for (const t of [...scope.tests, ...scope.globals]) console.log(t)
}
