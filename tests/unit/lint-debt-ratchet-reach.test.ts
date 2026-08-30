/**
 * HELLGATE — the ratchet's universe must be at least as wide as biome's.
 *
 * `bun run lint` and `bun run lint:debt` do not hand biome a directory. They
 * hand it an explicit file list built by `collectBiomeTargets`, which enumerates
 * by EXTENSION. Anything that list omits is not "clean"; it was never looked at.
 * Both surfaces then report a confident number over a universe smaller than the
 * linter's, which is the exact defect this repo keeps finding in its own scans.
 *
 * MEASURED, 2026-08-27, before this file existed:
 *
 *   collectBiomeTargets(repo)                          7171 files, 0 of them .html
 *   biome check src   (its own traversal)              names src/apps/bench/trace-viewer.html
 *                                                      with 23 diagnostics across 8 rules —
 *                                                      2 of them ERROR severity, which
 *                                                      `bun run lint` exits non-zero on —
 *                                                      and cognitive complexity 35, tied for
 *                                                      the highest single score in src/
 *
 * So `noExcessiveCognitiveComplexity prod=36/36` was not 36 of 36. It was 36 of
 * 37, with the joint-worst site outside the count, and two lint ERRORS sitting
 * green. Complexity could have been added to that file forever.
 *
 * ## Why the property is phrased as containment, not as a file count
 *
 * The two universes are not meant to be equal. `collectBiomeTargets` deliberately
 * drops things biome would otherwise process (a `.js` twin of an authoritative
 * `.ts`, `*.from-worktree` leftovers), and `biome.json` deliberately drops things
 * the enumerator lists (`**\/*.d.ts`, `tests/smoke/fixtures`). A count comparison
 * would have to encode every one of those and would go red on each new one.
 *
 * The property that actually matters is one-directional:
 *
 *     { files biome lints }  ⊆  { files the ratchet enumerates }
 *
 * and it is checked COMPLETELY, not sampled: every file under the source roots
 * that the enumerator rejects is handed back to biome, and biome must agree it
 * is not lintable. Ground truth comes from the shipped binary — `Checked N
 * file(s)` — not from a hand-written list of extensions, because a hand-written
 * list is the thing that broke.
 *
 * ## The DIAGNOSTIC form of the same property lives in tests/integration
 *
 * "every diagnostic biome raises under the roots lands on an enumerated file"
 * moved to `tests/integration/lint-debt-reach-e2e.test.ts`. It runs biome over
 * ALL of src/ and tests/ with a JSON reporter: measured 18,096ms inside a full
 * `bun test tests/unit` run, against a per-test unit budget of 8,529ms
 * (`tools/dev/unit-speed-budget.json`) that may only go DOWN, and faking the
 * linter is exactly what neither half may do. The two cases here — the paired
 * non-degeneracy control and the complete FILE-form containment — are the fast
 * ones and stay.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { collectBiomeTargets, shouldIncludeBiomeTarget } from "../../tools/dev/biome-targets"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const BIOME_BIN = join(REPO_ROOT, "node_modules/.bin/biome")
const ROOTS = ["src", "tests"] as const

const allFilesUnder = (relDir: string, out: string[]): string[] => {
  let entries: string[]
  try {
    entries = readdirSync(join(REPO_ROOT, relDir))
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(REPO_ROOT, relDir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(abs)
    } catch {
      continue
    }
    const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/")
    if (s.isDirectory()) allFilesUnder(rel, out)
    else if (s.isFile()) out.push(rel)
  }
  return out
}

const CHECKED_RE = /Checked (\d+) files?/

/**
 * How many of `paths` the SHIPPED biome binary considers lintable.
 *
 * `null` means the answer could not be read — a crashed binary, a changed
 * summary line — and every caller treats that as a failure rather than as zero.
 * A silent 0 here would make this whole file vacuous, which is the failure mode
 * it exists to catch.
 */
const biomeChecks = (paths: readonly string[]): number | null => {
  if (paths.length === 0) return 0
  let total = 0
  for (let i = 0; i < paths.length; i += 400) {
    const run = Bun.spawnSync({
      cmd: [BIOME_BIN, "check", "--max-diagnostics=1", ...paths.slice(i, i + 400)],
      cwd: REPO_ROOT,
    })
    const text = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`
    const m = CHECKED_RE.exec(text)
    if (m?.[1] === undefined) return null
    total += Number(m[1])
  }
  return total
}

describe("lint-debt reach — the ratchet must enumerate everything biome lints", () => {
  const rootFiles = ROOTS.map((root) => allFilesUnder(root, []))
  const [srcFiles, testFiles] = rootFiles
  if (srcFiles === undefined || testFiles === undefined) {
    throw new Error("lint-debt reach: both configured roots must be enumerated")
  }
  assertScanPopulation(srcFiles, join(REPO_ROOT, ROOTS[0]), {
    collectable: () => true,
    id: "tests/unit/lint-debt-ratchet-reach.test.ts#SRC",
  })
  assertScanPopulation(testFiles, join(REPO_ROOT, ROOTS[1]), {
    collectable: () => true,
    id: "tests/unit/lint-debt-ratchet-reach.test.ts#TESTS",
  })
  const files = rootFiles.flat()
  const rejected = files.filter((f) => !shouldIncludeBiomeTarget(REPO_ROOT, f))
  const targets = collectBiomeTargets(REPO_ROOT)

  test("the probe is non-degenerate (it can say yes as well as no)", () => {
    // Paired control. If `biomeChecks` returned 0 for everything — wrong flag,
    // wrong cwd, drifted summary line — the containment test below would pass
    // while measuring nothing at all.
    const known = targets.filter((t) => t.endsWith(".ts")).slice(0, 3)
    expect(known.length).toBe(3)
    expect(biomeChecks(known)).toBe(3)
    expect(biomeChecks(["README.md"])).toBe(0)
  })

  test("every file the enumerator REJECTS is one biome also refuses to lint", () => {
    // Anti-vacuity: there must be a real population on both sides, or "0 of 0"
    // would read as a pass.
    expect(files.length).toBeGreaterThan(1000)
    expect(targets.length).toBeGreaterThan(1000)
    expect(rejected.length).toBeGreaterThan(10)

    const checked = biomeChecks(rejected)
    if (checked === 0) return
    // Name the offenders rather than reporting a bare number — the fix is a
    // change to the enumerator's extension set, and the fixer needs the paths.
    const offenders = rejected.filter((f) => biomeChecks([f]) !== 0)
    expect({ checked, offenders }).toEqual({ checked: 0, offenders: [] })
  }, 300_000)
})
