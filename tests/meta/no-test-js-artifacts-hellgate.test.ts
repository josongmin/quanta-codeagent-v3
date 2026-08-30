import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../unit/_shared/scan-population"

/**
 * Hellgate: prevent .test.js artifact contamination.
 *
 * Symptom this catches: stale TS-emit lying next to .test.ts source, causing
 * double execution at test time and slow gate. Reproduced 2026-05-25 with 520
 * orphan .test.js files / 505 sibling pairs (T1 cleanup commit).
 *
 * Enforcement: filesystem walk asserts zero .test.js under tests/.
 */
/** Anchored on THIS file — the seeds below were bare `"tests"` and resolved
 *  against the ambient cwd. Found by `tools/dev/cwd-parity-check.ts`. */
const REPO_ROOT = join(import.meta.dir, "..", "..")

function findTestJs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) findTestJs(full, out)
    else if (entry.name.endsWith(".test.js")) out.push(full)
  }
  return out
}

/** How many `.test.ts` the same walk reaches — the floor's only job is to prove
 *  the traversal happened at all, so it mirrors findTestJs exactly but counts the
 *  files that DO exist rather than the ones that must not. */
function findTestTs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) findTestTs(full, out)
    else if (entry.name.endsWith(".test.ts")) out.push(full)
  }
  return out
}

describe("no .test.js artifacts under tests/", () => {
  test("zero .test.js files exist", () => {
    const testsRoot = join(REPO_ROOT, "tests")
    const victims = findTestJs(testsRoot)
    const testFiles = findTestTs(testsRoot)
    assertScanPopulation(testFiles, testsRoot, {
      id: "tests/meta/no-test-js-artifacts-hellgate.test.ts#TESTS",
      collectable: (name) => name.endsWith(".test.ts"),
    })
    // Anti-vacuity. The verdict is `victims === []`, so a walk that reads NOTHING
    // is the same green as a clean tree — and this guard exists because 520
    // orphan `.test.js` files once caused double execution, which is exactly the
    // failure it must not miss. `findTestTs` counts what was actually reached.
    expect(
      testFiles.length,
      "the walk read no test files — the assertion below is vacuous",
    ).toBeGreaterThan(3054)
    expect(victims).toEqual([])
  })

  test("zero sibling .test.js for any .test.ts (defense-in-depth)", () => {
    const siblings = findTestTs(join(REPO_ROOT, "tests"))
      .map((ts) => ts.replace(/\.test\.ts$/, ".test.js"))
      .filter((js) => {
        try {
          statSync(js)
          return true
        } catch {
          return false
        }
      })
    expect(siblings).toEqual([])
  })
})
