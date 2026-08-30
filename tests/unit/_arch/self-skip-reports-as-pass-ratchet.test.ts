/**
 * Ratchet — a test that decides not to run must SKIP, never silently pass.
 *
 * ## The shape
 *
 * ```ts
 * test("checks the thing", () => {
 *   if (!toolAvailable) return      // ← bun counts this as a PASS
 *   …
 * })
 * ```
 *
 * `bun test` has no way to know the body returned early, so the test is reported
 * green and does not appear in the skip counter. It is invisible in both places
 * a reader would look.
 *
 * ## Measured, not hypothetical
 *
 * `ast-grep` is not installed on this machine. Before the conversion,
 * `ast-grep-scenarios.test.ts` reported **23 pass, 0 skip, 15 expect() calls** —
 * fourteen of the twenty-three asserted nothing and every one of them was green.
 * Across the four ast-grep files, 18 tests reported as passing while executing no
 * assertion at all. After converting to `test.skipIf(...)` the same run reports
 * 9 pass / 14 skip, which is the truth and is legible.
 *
 * ## Why the allowlist exists
 *
 * Twenty-five other sites carry the shape today, and on this machine every one of
 * their conditions is FALSE — they guard `process.platform === "win32"` and a
 * missing `python3`, so the tests actually run here and the defect is latent
 * rather than live. Converting them is mechanical but touches twelve files owned
 * by other work, and the honest reason to do it is legibility on a Windows or
 * python-less machine, not a bug here. So they are listed rather than silently
 * tolerated, and the list may only shrink.
 *
 * What must not happen is a twenty-sixth, or a regression of the eighteen already
 * converted.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * A test whose FIRST statement is a bare conditional `return`.
 *
 * Anchored to the start of the body on purpose. A conditional return LATER in a
 * test is ordinary control flow over work already asserted; one at the top is a
 * skip wearing a pass. Matching anywhere in the body would flag hundreds of
 * legitimate early exits and get the rule deleted rather than followed.
 */
const SELF_SKIP =
  /\b(?:it|test)\s*\(\s*(["'`])(?:\\.|(?!\1).)*\1[^\n]*\)\s*=>\s*\{\s*\n\s*if\s*\([^\n]*\)\s*(?:\{\s*\n\s*)?return\b/g

export const selfSkipSites = (source: string): number => [...source.matchAll(SELF_SKIP)].length

/** Every `*.test.ts` under `tests/` and `src/`, anchored on this file. */
const testFiles = (): readonly string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (abs.endsWith(".test.ts")) out.push(abs.slice(REPO_ROOT.length + 1))
    }
  }
  walk(join(REPO_ROOT, "tests"))
  walk(join(REPO_ROOT, "src"))
  return out.sort()
}

/**
 * Files that still self-skip, with the count. One-directional: a number may go
 * DOWN or the entry may disappear; it may never rise, and a new file may not
 * appear.
 *
 * Every condition here is a platform or external-tool probe that is FALSE on
 * macOS/Linux with the standard toolchain, so these run rather than silently
 * pass. That is why they are tolerated and the ast-grep ones were not.
 */
const KNOWN: Readonly<Record<string, number>> = {
  "tests/integration/browser-real-chrome-adversarial-e2e.test.ts": 2,
  "tests/unit/apps/bench/promax/promax-bundle-assembly.test.ts": 2,
  "tests/unit/apps/cli/at-autocomplete/recursive-file-list-characterization.test.ts": 9,
  "tests/unit/apps/cli/rewind-harness-messages-hellgate.test.ts": 1,
  "tests/unit/auth/token-store.test.ts": 2,
  "tests/unit/bash-mode-hellgate.test.ts": 1,
  "tests/unit/cli/fetch-rules-hellgate.test.ts": 1,
  "tests/unit/git/conflict-parser-differential-fuzz.test.ts": 1,
  "tests/unit/retrieval/indexer-hellgate.test.ts": 2,
  "tests/unit/sphinx-ra-shim.test.ts": 1,
  "tests/unit/tool/glob-gitignore-mtime-hellgate.test.ts": 1,
  "tests/unit/tool/glob-pattern-jail-escape-hellgate.test.ts": 2,
}

describe("a self-skip must not report as a pass", () => {
  const files = testFiles()

  test("anti-vacuity: the walk reached the real test tree", () => {
    assertScanPopulation(
      files.filter((file) => file.startsWith("tests/")).map((file) => join(REPO_ROOT, file)),
      join(REPO_ROOT, "tests"),
      {
        id: "tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts#TESTS",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    assertScanPopulation(
      files.filter((file) => file.startsWith("src/")).map((file) => join(REPO_ROOT, file)),
      join(REPO_ROOT, "src"),
      {
        id: "tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts#SRC",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    // This ratchet is an instance of the class it guards — a walk that read
    // nothing would report "no self-skips" just as convincingly.
    expect(
      files.length,
      "the walk read no test files — the counts below are vacuous",
    ).toBeGreaterThan(3000)
  })

  test("🔴 the detector fires on the shape, and not on an ordinary early return", () => {
    expect(selfSkipSites('test("x", () => {\n  if (!have) return\n  expect(1).toBe(1)\n})')).toBe(1)
    expect(
      selfSkipSites(
        'it("x", async () => {\n  if (!have) {\n    return\n  }\n  expect(1).toBe(1)\n})',
      ),
    ).toBe(1)
    // An early return AFTER real work is control flow, not a skip.
    expect(
      selfSkipSites(
        'test("x", () => {\n  expect(1).toBe(1)\n  if (done) return\n  expect(2).toBe(2)\n})',
      ),
    ).toBe(0)
    expect(selfSkipSites('test.skipIf(!have)("x", () => {\n  expect(1).toBe(1)\n})')).toBe(0)
  })

  test("no NEW file self-skips, and no known count rises", () => {
    const offenders: string[] = []
    for (const rel of files) {
      const n = selfSkipSites(readFileSync(join(REPO_ROOT, rel), "utf8"))
      if (n === 0) continue
      const allowed = KNOWN[rel]
      if (allowed === undefined) {
        offenders.push(`${rel}: ${n} new self-skip(s)`)
      } else if (n > allowed) {
        offenders.push(`${rel}: ${n} > ${allowed}`)
      }
    }
    expect(
      offenders.sort(),
      offenders.length === 0
        ? ""
        : "a test that returns early reports as a PASS and never appears in the skip " +
            "counter — use `test.skipIf(condition)` so the environment gate is legible:\n  " +
            offenders.join("\n  "),
    ).toEqual([])
  })

  test("no allowlist entry is stale — a converted file must be removed", () => {
    const stale = Object.entries(KNOWN)
      .filter(([rel, n]) => {
        try {
          return selfSkipSites(readFileSync(join(REPO_ROOT, rel), "utf8")) < n
        } catch {
          return true
        }
      })
      .map(([rel]) => rel)
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : `these improved — lower or remove their entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})
