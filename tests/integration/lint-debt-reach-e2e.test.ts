/**
 * HELLGATE (INTEGRATION) — every diagnostic biome raises inside the source roots
 * must land on a file the lint-debt ratchet enumerates.
 *
 * `bun run lint` and `bun run lint:debt` do not hand biome a directory. They
 * hand it an explicit file list built by `collectBiomeTargets`, which enumerates
 * by EXTENSION. Anything that list omits is not "clean"; it was never looked at,
 * and the ceiling then reports a confident number over a universe smaller than
 * the linter's. MEASURED 2026-08-27: `noExcessiveCognitiveComplexity prod=36/36`
 * was 36 of 37, the joint-worst site (`src/apps/bench/trace-viewer.html`, score
 * 35) sitting outside the count together with two lint ERRORS.
 *
 * This is the DIAGNOSTIC form of the property. The FILE form — every file the
 * enumerator rejects is one biome also refuses to lint, checked completely
 * rather than sampled — stays in `tests/unit/lint-debt-ratchet-reach.test.ts`
 * with its paired non-degeneracy control.
 *
 * WHY tests/integration AND NOT tests/unit. It runs the shipped biome binary
 * over ALL of `src/` and `tests/` with a JSON reporter: measured 18,096ms inside
 * a full `bun test tests/unit` run, against a per-test unit budget of 8,529ms
 * (`tools/dev/unit-speed-budget.json`) that may only go DOWN. Faking the linter
 * is ruled out by the point of the test — ground truth must come from the
 * shipped binary, because a hand-written list of extensions is the thing that
 * broke — so the remedy the budget itself names ("move it to tests/integration")
 * is the one taken. `bun run test` and the CI pyramid both run tests/integration.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { collectBiomeTargets } from "../../tools/dev/biome-targets"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const BIOME_BIN = join(REPO_ROOT, "node_modules/.bin/biome")
const ROOTS = ["src", "tests"] as const

type BiomeDiagnostic = { readonly location?: { readonly path?: unknown } }

/** Repo-relative path of a diagnostic; `""` when biome reported none. */
const relPathOf = (d: BiomeDiagnostic): string => {
  const p = d.location?.path
  const raw =
    typeof p === "string"
      ? p
      : p && typeof p === "object" && "file" in p
        ? String((p as { file: unknown }).file)
        : ""
  if (raw === "") return ""
  const rel = raw.startsWith(`${REPO_ROOT}/`) ? raw.slice(REPO_ROOT.length + 1) : raw
  return rel.replaceAll("\\", "/")
}

/**
 * Every diagnostic biome raises when it walks the source roots ITSELF, rather
 * than being handed a file list. This is the ground truth the ratchet's own scan
 * is compared against; a missing report throws instead of yielding an empty
 * array, because an empty array here reads exactly like a pass.
 */
const biomeDiagnosticsOverRoots = (): readonly BiomeDiagnostic[] => {
  const dir = mkdtempSync(join(tmpdir(), "lint-reach-"))
  const reportPath = join(dir, "report.json")
  try {
    const run = Bun.spawnSync({
      cmd: [
        BIOME_BIN,
        "check",
        "--reporter=json",
        `--reporter-file=${reportPath}`,
        "--max-diagnostics=100000",
        ...ROOTS,
      ],
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "pipe",
    })
    let raw: string
    try {
      raw = readFileSync(reportPath, "utf8")
    } catch {
      const stderr = new TextDecoder().decode(run.stderr)
      throw new Error(`biome produced no JSON report (exit ${run.exitCode}): ${stderr}`)
    }
    const parsed = JSON.parse(raw) as { diagnostics?: readonly BiomeDiagnostic[] }
    if (!Array.isArray(parsed.diagnostics)) {
      throw new Error("biome JSON report has no `diagnostics` array — reporter shape drifted")
    }
    return parsed.diagnostics
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("lint-debt reach — every biome diagnostic lands on an enumerated file", () => {
  const targets = collectBiomeTargets(REPO_ROOT)

  /**
   * The same property stated over DIAGNOSTICS instead of files: a diagnostic
   * biome raises inside the source roots must land on a file the ratchet counts.
   * Weaker than the containment test above — it goes quiet as soon as the
   * unenumerated file happens to be clean — but it is the form the ceiling
   * actually consumes, so it is pinned in that form too.
   */
  test("every diagnostic biome raises under src/ and tests/ lands on an enumerated file", () => {
    const diagnostics = biomeDiagnosticsOverRoots()
    expect(diagnostics.length).toBeGreaterThan(0) // anti-vacuity

    const enumerated = new Set(targets)
    const unseen = diagnostics
      .map((d) => relPathOf(d))
      .filter((rel) => rel !== "" && !enumerated.has(rel))
    expect([...new Set(unseen)].sort()).toEqual([])
  }, 300_000)
})
