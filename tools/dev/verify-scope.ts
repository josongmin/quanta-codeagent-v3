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
 * WHAT IT PROMISES. The contract is DO NOT MISS. Size is secondary, and every
 * narrowing is re-checked against the misses that motivated the tool — a
 * smaller wrong answer is worth nothing.
 *
 * BARRELS. `import { x } from "@/tool"` does not mean "depends on everything
 * @/tool re-exports", and treating it that way saturated the result: a core
 * module came back with 3,327 of 3,730 test files. 818 of this repo's 841
 * barrel edges are NAMED, so they resolve per SYMBOL — a consumer reaches only
 * the module defining the name it asked for, and a barrel's own
 * `export { … } from` no longer emits a whole-module edge. Measured: 3,327 →
 * 1,382 and 2,327 → 1,736, with all five known cases still found. The remaining
 * `export * from` sites keep the wide edge, since resolving them per symbol
 * needs following into the target, and guessing would trade a true wide answer
 * for a possibly-false narrow one.
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
const MOCK_MODULE_RE = /mock\.module\(\s*["']([^"']+)["']/g

/** `require("…")` — few sites today, but a form left out is how a scope quietly
 *  starts lying. */
const REQUIRE_RE = /require\(\s*["']([^"']+)["']/g

/** `import { a, b as c } from "spec"` — the NAMED bindings, which is what makes
 *  per-symbol barrel resolution possible. Default / namespace / bare imports are
 *  deliberately NOT matched: they pull the whole module, so they keep the coarse
 *  edge. */
const NAMED_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g

/** `export { a, b as c } from "spec"` in a barrel: visible name → defining module. */
const NAMED_REEXPORT_RE = /export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g

/** `export * from "spec"`. Cannot be resolved per-symbol without following into
 *  the target, so these keep the WIDE edge on purpose. */
const STAR_REEXPORT_RE = /export\s*\*\s*from\s*["']([^"']+)["']/g

/** The name a consumer sees: `a` from `a`, `c` from `b as c`. */
const boundName = (clause: string): string =>
  (
    clause
      .trim()
      .split(/\s+as\s+/)
      .pop() ?? ""
  ).trim()

/** The name the source module knows: `a` from `a`, `b` from `b as c`. */
const sourceName = (clause: string): string => (clause.trim().split(/\s+as\s+/)[0] ?? "").trim()

/** Extract dependency specifiers, including mock-only replacement edges.
 * Exported so the mock edge has a non-vacuous unit rail: in this tree most
 * mocked modules are also reachable through an ordinary import. */
export const specifiersOfText = (text: string): string[] => {
  const out: string[] = []
  for (const pattern of [SPEC_RE, MOCK_MODULE_RE, REQUIRE_RE]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) out.push(specifier)
    }
  }
  return out
}

const readText = (rel: string): string | null => {
  try {
    return readFileSync(join(REPO_ROOT, rel), "utf8")
  } catch {
    return null
  }
}

const specifiersOf = (rel: string): string[] => {
  const text = readText(rel)
  return text === null ? [] : specifiersOfText(text)
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"] as const

/** Resolve one specifier to a repo-relative file, or null when it is a package
 *  (`node:fs`, `zod`) or something no candidate suffix names. `@/x` is the
 *  repo's `src/x` alias — the reason a purely textual search misses case 3 is
 *  that the alias hides the directory the guard actually lives in. */
const resolveSpecifier = (
  fromFile: string,
  spec: string,
  known: ReadonlySet<string>,
): string | null => {
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

interface VerificationGraph {
  readonly known: ReadonlySet<string>
  readonly testFiles: readonly string[]
  readonly importedBy: ReadonlyMap<string, readonly string[]>
}

/** Barrel symbol tables: file → (visible name → defining module). Built first
 *  because the edge pass below resolves consumers THROUGH them. */
const buildReexportTables = (
  files: readonly string[],
  known: ReadonlySet<string>,
): Map<string, Map<string, string>> => {
  const tables = new Map<string, Map<string, string>>()
  for (const file of files) {
    const text = readText(file)
    if (text === null || !text.includes("} from")) continue
    let table: Map<string, string> | undefined
    for (const match of text.matchAll(NAMED_REEXPORT_RE)) {
      const spec = match[2]
      if (spec === undefined) continue
      const target = resolveSpecifier(file, spec, known)
      if (target === null) continue
      table ??= new Map<string, string>()
      for (const clause of (match[1] ?? "").split(",")) {
        const name = boundName(clause)
        if (name.length > 0) table.set(name, target)
      }
    }
    if (table !== undefined) tables.set(file, table)
  }
  return tables
}

const buildVerificationGraph = (): VerificationGraph => {
  const files = allSourceFiles()
  const known = new Set(files)
  const reexports = buildReexportTables(files, known)

  /** Follow `name` through barrels to the module that DEFINES it. Bounded so a
   *  re-export cycle cannot spin; the bound is a graph fact, not a tuning knob. */
  const throughBarrel = (target: string, name: string): string => {
    let at = target
    for (let hop = 0; hop < 16; hop++) {
      const next = reexports.get(at)?.get(name)
      if (next === undefined || next === at) return at
      at = next
    }
    return at
  }

  const importedBy = new Map<string, string[]>()
  const addEdge = (target: string, importer: string): void => {
    if (target === importer) return
    const importers = importedBy.get(target)
    if (importers === undefined) importedBy.set(target, [importer])
    else importers.push(importer)
  }

  for (const file of files) {
    const text = readText(file)
    if (text === null) continue

    // NAMED imports reach only the module that defines the name asked for.
    const namedSpecs = new Set<string>()
    for (const match of text.matchAll(NAMED_IMPORT_RE)) {
      const spec = match[2]
      if (spec === undefined) continue
      const target = resolveSpecifier(file, spec, known)
      if (target === null) continue
      namedSpecs.add(spec)
      addEdge(target, file)
      for (const clause of (match[1] ?? "").split(",")) {
        const name = sourceName(clause)
        if (name.length > 0) addEdge(throughBarrel(target, name), file)
      }
    }

    // A barrel's OWN `export { x } from "./M"` must not become a whole-module
    // edge: that is what made every consumer of a barrel a dependent of every
    // module it re-exports. Consumers reach M through `throughBarrel` instead.
    const reexportSpecs = new Set<string>()
    for (const match of text.matchAll(NAMED_REEXPORT_RE)) {
      const spec = match[2]
      if (spec !== undefined) reexportSpecs.add(spec)
    }

    // Everything else genuinely pulls the whole module.
    for (const spec of specifiersOfText(text)) {
      if (namedSpecs.has(spec) || reexportSpecs.has(spec)) continue
      const target = resolveSpecifier(file, spec, known)
      if (target !== null) addEdge(target, file)
    }
    for (const match of text.matchAll(STAR_REEXPORT_RE)) {
      const spec = match[1]
      if (spec === undefined) continue
      const target = resolveSpecifier(file, spec, known)
      if (target !== null) addEdge(target, file)
    }
  }

  return { known, testFiles: files.filter(isTestFile), importedBy }
}

// The source tree cannot change coherently during one verifier process. Build
// the graph during module initialization so each derived scope shares the same
// snapshot and the first test/caller does not absorb all filesystem cold-start
// latency inside its own timeout.
const VERIFICATION_GRAPH = buildVerificationGraph()

/**
 * The tests that can observe `changed`, plus the scanners that always run.
 *
 * Walks the import graph BACKWARDS: build `importer → imported`, invert it, then
 * flood out from the changed files. Inversion rather than per-test forward
 * search because the graph is walked once for any number of changed files.
 */
export const deriveVerificationScope = (changed: readonly string[]): VerificationScope => {
  const { known, testFiles, importedBy } = VERIFICATION_GRAPH

  // Flood outward from the changed set. A changed file that nothing imports is
  // still its own dependent, so a test file edited directly is in scope.
  const reached = new Set<string>()
  const queue = changed.filter((file) => known.has(file))
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
