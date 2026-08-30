/**
 * NARROW orphan-ORCHESTRATOR ratchet (D3 follow-up, 2026-07-15).
 *
 * PROBLEM. The bench eval driver had TWO copies of the per-instance phase
 * orchestrators. The LIVE copy is the app driver (`src/apps/bench/eval/driver.ts`
 * — `runAppMainPhase` → local `runRepairPhase` / `runSelectionPhase`). The runner
 * core `src/runner/batch/eval/driver/**` carried a DEAD duplicate triad
 * (`runMainPhase` / `runRepairPhase` / `runSelectionPhase`) with ZERO runtime
 * callers — not re-exported by the barrel, not imported by any src module, not
 * imported by any test — plus the now-dead `agent-phase.ts` those orchestrators
 * transitively kept alive. They were deleted (D3). This ratchet prevents a NEW
 * dead orchestrator from re-accreting in the runner-core driver subtree.
 *
 * WHY NARROW (per review). A repo-wide "every export must be called" checker is
 * WRONG: exported symbols can be legit SDK / plugin / dynamic-import consumers,
 * and multiple adapters per capability is normal. So this ratchet is scoped hard:
 *   - ONLY the runner-core driver subtree (`src/runner/batch/eval/driver/**`).
 *   - ONLY exported FUNCTIONS (arrow-const or function-decl), not types/consts.
 *   - A function is an "orphan" ONLY when it is dead from EVERY consumer surface:
 *       (a) ZERO reference in all of `src/**` outside its own defining file and
 *           pure re-export barrel lines (`export { X } from "…"`),
 *       (b) NOT re-exported from any SDK barrel (`src/sdk/**`), and
 *       (c) NO `import` of the name anywhere in `tests/**`.
 *     A symbol that ANY of those surfaces consumes is NOT flagged — so a
 *     test-only-covered export (e.g. `maybeCriticRefute`) or a barrel-exported
 *     library helper (e.g. `cleanupSelectionCandidateSandbox`) never trips it.
 *
 * The reference scan is via the TypeScript AST (identifier nodes), NOT grep — so
 * doc-comment mentions of a name are NOT counted as consumers (that is exactly
 * how `runRepairPhase` looked "referenced" to grep while being truly dead).
 *
 * BASELINE. One PRE-EXISTING orphan helper already sits dead in the subtree
 * (`adaptiveRouteTelemetryOf` — a leaf, NOT an orchestrator, pre-dates D3). It is
 * recorded here as reviewed debt so the ratchet fires only on a NEW orphan. A
 * baseline entry that stops being an orphan (gets a consumer, or is deleted) must
 * be removed — the ratchet flags a STALE baseline entry too, so the debt list
 * can't rot. (Same-file internal callers count as consumers, so helpers like
 * `reproducingReproSources` / `reproArtifactPathOf`, called within their own
 * module, are correctly NOT orphans.)
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")
const TESTS_ROOT = join(REPO_ROOT, "tests")
const SDK_ROOT = join(SRC_ROOT, "sdk")
const DRIVER_ROOT = join(SRC_ROOT, "runner", "batch", "eval", "driver")

/**
 * Reviewed baseline of PRE-EXISTING orphan exports in the driver subtree. This
 * is a dead leaf helper (not an orchestrator) that pre-dates the D3 cleanup; it
 * is out of scope for this task but recorded so the ratchet fires only on NEW
 * orphans. Each entry is `defining-file (relative to src/) :: exported name`.
 * Removing the dead code (or wiring a consumer) ⇒ delete the matching entry.
 */
const BASELINE_ORPHANS: ReadonlySet<string> = new Set([
  "runner/batch/eval/driver/adaptive-evidence.ts::adaptiveRouteTelemetryOf",
])

const parse = (path: string, src: string): ts.SourceFile =>
  ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const listTsFiles = (dir: string): string[] => {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (
      st.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".spec.ts")
    ) {
      out.push(full)
    }
  }
  return out.sort()
}

/** An exported function declared in the driver subtree. `srcKey` is the stable
 *  `relative-to-src :: name` identity used against the baseline. */
interface ExportedFn {
  readonly name: string
  readonly file: string
  readonly srcKey: string
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

/** Names of `export const foo = (…) => …` / `= async (…) => …` in one statement. */
const exportedArrowConstNames = (stmt: ts.Statement): string[] => {
  if (!ts.isVariableStatement(stmt) || !hasExportModifier(stmt)) return []
  return stmt.declarationList.declarations
    .filter(
      (d) =>
        ts.isIdentifier(d.name) &&
        d.initializer !== undefined &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)),
    )
    .map((d) => (d.name as ts.Identifier).text)
}

/** Name of an `export function foo(){}` / `export async function foo(){}`. */
const exportedFunctionDeclName = (stmt: ts.Statement): string | undefined =>
  ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)
    ? stmt.name.text
    : undefined

/** Collect exported FUNCTIONS (arrow-const or function-decl) from one source. */
const exportedFunctionsOf = (sf: ts.SourceFile, file: string): ExportedFn[] => {
  const rel = relative(SRC_ROOT, file).split("\\").join("/")
  const names = sf.statements.flatMap((stmt) => {
    const decl = exportedFunctionDeclName(stmt)
    return decl !== undefined ? [decl] : exportedArrowConstNames(stmt)
  })
  return names.map((name) => ({ name, file, srcKey: `${rel}::${name}` }))
}

/** Is `node` inside a PURE re-export barrel (`export { X } from "…"`)? Such a
 *  line names a symbol only to forward it; it is NOT a consumer. */
const isBarrelExportContext = (node: ts.Node): boolean => {
  let cur: ts.Node | undefined = node
  while (cur) {
    if (ts.isExportDeclaration(cur) && cur.moduleSpecifier !== undefined) return true
    cur = cur.parent
  }
  return false
}

/** Count AST identifier references to `name` in `sf`, EXCLUDING the identifier
 *  that is the declaration's own name and EXCLUDING pure re-export barrel lines.
 *  Comments never appear as identifier nodes, so doc-mentions are ignored. */
const referenceCount = (sf: ts.SourceFile, name: string, isDefiningFile: boolean): number => {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      // Skip the declaration's own binding identifier in its defining file.
      const p = node.parent
      const isOwnBinding =
        isDefiningFile &&
        ((ts.isFunctionDeclaration(p) && p.name === node) ||
          (ts.isVariableDeclaration(p) && p.name === node))
      if (!isOwnBinding && !isBarrelExportContext(node)) count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return count
}

// ── Build the corpus once ──────────────────────────────────────────────────
const isProductionTs = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".d.ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".spec.ts")
const SRC_TS = listTsFiles(SRC_ROOT)
assertScanPopulation(SRC_TS, SRC_ROOT, {
  collectable: isProductionTs,
  id: "tests/unit/orphan-orchestrator-ratchet.test.ts#SRC",
})
const SDK_TS = listTsFiles(SDK_ROOT)
assertScanPopulation(SDK_TS, SDK_ROOT, {
  collectable: isProductionTs,
  id: "tests/unit/orphan-orchestrator-ratchet.test.ts#SDK",
})
const SRC_FILES = SRC_TS.map((f) => ({ f, sf: parse(f, readFileSync(f, "utf8")) }))
const SDK_FILES = SDK_TS.map((f) => ({ f, sf: parse(f, readFileSync(f, "utf8")) }))
const TEST_TS = ((): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) out.push(full)
    }
  }
  walk(TESTS_ROOT)
  return out.sort()
})()
const TEST_SOURCES = TEST_TS.map((f) => readFileSync(f, "utf8"))

assertScanPopulation(TEST_TS, TESTS_ROOT, {
  collectable: (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  id: "tests/unit/orphan-orchestrator-ratchet.test.ts#TESTS",
})
const DRIVER_TS = listTsFiles(DRIVER_ROOT)
assertScanPopulation(DRIVER_TS, DRIVER_ROOT, {
  collectable: isProductionTs,
  id: "tests/unit/orphan-orchestrator-ratchet.test.ts#DRIVER",
})
const DRIVER_EXPORTS: ExportedFn[] = DRIVER_TS.flatMap((f) =>
  exportedFunctionsOf(parse(f, readFileSync(f, "utf8")), f),
)

/** src references to `fn.name` across all of src, excluding its own defining
 *  file and pure barrel re-export lines. */
const srcConsumerCount = (fn: ExportedFn): number =>
  SRC_FILES.reduce((acc, { f, sf }) => acc + referenceCount(sf, fn.name, f === fn.file), 0)

/** Is `fn` re-exported from any SDK barrel (`src/sdk/**`)? An SDK re-export is a
 *  legit external-consumer surface, so such a symbol is NEVER an orphan. */
const isSdkReExported = (fn: ExportedFn): boolean =>
  SDK_FILES.some(({ sf }) => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        if (node.exportClause.elements.some((e) => e.name.text === fn.name)) found = true
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  })

/** Does any test IMPORT `fn.name` (a runtime consumer surface)? Import specifier
 *  match only — a bare textual mention in a test comment is NOT a consumer. */
const importedByTest = (fn: ExportedFn): boolean =>
  TEST_SOURCES.some((src) => {
    if (!src.includes(fn.name)) return false // cheap pre-filter
    const sf = parse("t.ts", src)
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        if (node.importClause.namedBindings.elements.some((e) => e.name.text === fn.name)) {
          found = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  })

const isOrphan = (fn: ExportedFn): boolean =>
  srcConsumerCount(fn) === 0 && !isSdkReExported(fn) && !importedByTest(fn)

const CURRENT_ORPHANS: ExportedFn[] = DRIVER_EXPORTS.filter(isOrphan)

describe("orphan-orchestrator ratchet — runner/batch/eval/driver subtree", () => {
  test("scanner is non-vacuous: it finds the driver subtree's exported functions", () => {
    // Floor guard: if the scan silently returns nothing (bad glob / parse), the
    // ratchet has gone blind. The subtree exports dozens of functions.
    expect(DRIVER_EXPORTS.length).toBeGreaterThan(20)
    // And the deleted triad's LEAF helpers are still present + NON-orphan (they
    // have live app-driver callers) — proving the "has-consumer" path resolves.
    const leaf = DRIVER_EXPORTS.find((f) => f.name === "runRepairRoundsInSnapshot")
    expect(leaf).toBeDefined()
    if (leaf) expect(isOrphan(leaf)).toBe(false)
  })

  test("the deleted dead orchestrator triad is gone from the runner-core subtree", () => {
    const names = new Set(DRIVER_EXPORTS.map((f) => f.name))
    // D3: these dead duplicates must not re-accrete as runner-core exports.
    expect(names.has("runMainPhase")).toBe(false)
    expect(names.has("runRepairPhase")).toBe(false)
    expect(names.has("runSelectionPhase")).toBe(false)
    expect(names.has("runAgentPhase")).toBe(false)
    expect(names.has("runAgentOnce")).toBe(false)
  })

  test("no NEW orphan orchestrator has appeared (only the reviewed baseline is dead)", () => {
    const newOrphans = CURRENT_ORPHANS.map((f) => f.srcKey)
      .filter((k) => !BASELINE_ORPHANS.has(k))
      .sort()
    if (newOrphans.length > 0) {
      throw new Error(
        `New orphan orchestrator(s) in src/runner/batch/eval/driver/** — exported ` +
          `functions with ZERO consumers (no src reference, no SDK re-export, no ` +
          `test import). Either wire a real consumer, delete the dead code, or (if ` +
          `truly a reviewed exception) add to BASELINE_ORPHANS with justification:\n` +
          newOrphans.map((k) => `  - ${k}`).join("\n"),
      )
    }
    expect(newOrphans).toEqual([])
  })

  test("no STALE baseline entry (every baselined orphan is still dead + still present)", () => {
    const currentKeys = new Set(CURRENT_ORPHANS.map((f) => f.srcKey))
    const stale = [...BASELINE_ORPHANS].filter((k) => !currentKeys.has(k)).sort()
    if (stale.length > 0) {
      throw new Error(
        `Stale BASELINE_ORPHANS entr(ies) — no longer an orphan (got a consumer) ` +
          `or the symbol was removed. Delete these from the baseline:\n` +
          stale.map((k) => `  - ${k}`).join("\n"),
      )
    }
    expect(stale).toEqual([])
  })
})
