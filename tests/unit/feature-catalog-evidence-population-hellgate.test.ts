/**
 * Hellgate — a test cited as fc evidence must be in an execution population.
 *
 * # The gap this closes, and the one it does NOT change
 *
 * `feature-catalog-evidence-existence-hellgate` checks that each `evidence.tests`
 * path EXISTS on disk. That is its stated contract and it is not weakened here:
 * existence is a real check and a missing file is a real defect.
 *
 * What nothing checked is whether the file is ever RUN. Measured: 4,083 tracked
 * `*.test.ts(x)`, 4,041 reachable from some suite or out-of-band root, and 9
 * genuine orphans (the other 33 are `.test.tsx` under `apps/web-frontend`, which
 * the vitest lane really does run — the inventory matcher is `.test.ts`-only, so
 * that is an accounting gap, not a coverage one).
 *
 * One of those 9 is cited as `contract` evidence by a live L3 feature:
 *
 *     objective-goal-continuation-live → tests/smoke/goal/goal-pursuit-smoke.test.ts
 *
 * 325 lines, 19 expectations, anti-vacuum controls — and in no suite, no
 * out-of-band root, no gate, no workflow. Only `package.json`'s `smoke:goal`
 * script runs it, by hand. So the catalogue counted a proof nobody executes, and
 * the guard meant to keep evidence honest said yes because the bytes were there.
 *
 * # Why this is a new command rather than a widened one
 *
 * "the file exists" and "the file runs" are different claims with different
 * remedies (write the file vs. enroll it), and `check-evidence`'s meaning is
 * depended on elsewhere. Widening it would silently change what a green
 * `check-evidence` asserts.
 *
 * # Out-of-band evidence is allowed — DECLARED
 *
 * `real-api-smoke-eval` cites six `tests/eval/retrieval/*` files that are also in
 * no suite, and that is fine: its `deliberate_hold` says so in words ("기본 `bun
 * test` 에는 sweep 안 됨", with a promotion_path). That is the difference this
 * guard enforces — not "never cite an unswept test", but "say so". A feature that
 * cites one without declaring it is claiming a proof it does not run.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import {
  discoverOutOfBandPopulation,
  discoverSuiteFiles,
  OUT_OF_BAND_ROOTS,
  SUITE_ROOTS,
} from "../../tools/dev/test-shard-discovery"
import { loadFeaturesStrict } from "../../tools/feature-catalog/schema"

const ROOT = join(import.meta.dir, "..", "..")
const FEATURES_DIR = join(ROOT, "tools/feature-catalog/features")

/** Every test file any suite or out-of-band lane would execute. */
const executedPopulation = (): Set<string> => {
  const out = new Set<string>()
  const rel = (p: string): string => p.replace(`${ROOT}/`, "")
  for (const suite of Object.keys(SUITE_ROOTS) as Array<keyof typeof SUITE_ROOTS>) {
    for (const f of discoverSuiteFiles(ROOT, suite)) out.add(rel(f))
  }
  for (const name of Object.keys(OUT_OF_BAND_ROOTS) as Array<keyof typeof OUT_OF_BAND_ROOTS>) {
    for (const f of discoverOutOfBandPopulation(ROOT, name).files ?? []) out.add(rel(String(f)))
  }
  return out
}

const trackedTests = (): Set<string> =>
  new Set(
    execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter((p) => /\.test\.(ts|tsx)$/.test(p)),
  )

/**
 * Directories whose tests NO gate runs, quoting the owner that already established
 * it (`gated-test-scope-ratchet`'s `OUT_OF_BAND`). Closed on purpose: a new unswept
 * directory has to be added in both places, which is the moment to ask whether it
 * should be unswept at all.
 */
const OUT_OF_BAND_DIRS: Readonly<Record<string, string>> = {
  "tests/smoke/":
    'gated-test-scope-ratchet: "drives a real agent loop with recorded replay; minutes of wall clock and deliberately off the per-commit path"',
  "tests/eval/":
    'gated-test-scope-ratchet: "hits LIVE provider APIs and costs money — a gate that spends money is not a gate"',
}

/**
 * Whether a feature's own prose admits that part of its proof is NOT RUN by a gate.
 *
 * The phrasing is open but the CLAIM is not. A first version accepted the word
 * "smoke", and that was useless: `objective-goal-continuation-live` already
 * described its smoke suite at length, so deleting the actual out-of-band sentence
 * left the guard green. Naming a suite is not the same as saying nothing runs it.
 *
 * So the text has to assert the ABSENCE of automatic execution — "no gate", "not
 * run by", "out-of-band", "sweep", "manual". Each alternative below is a statement
 * about execution, never a topic word.
 */
const declaresOutOfBand = (text: string): boolean =>
  /\bout-of-band\b|\bsweep\b|\bno gate\b|\bnot run by\b|by no gate|manual(?:ly)? (?:only|run)|수동 실행|local only|nightly only/i.test(
    text,
  )

/** `.test.tsx` under the web app: the vitest lane runs these, but the inventory
 *  matcher is `.test.ts`-only so they never appear in a discovered population.
 *  An accounting gap, tracked separately rather than silently folded in. */
const isWebTsx = (p: string): boolean => p.startsWith("apps/web-frontend/") && p.endsWith(".tsx")

describe("fc evidence is in an execution population (P2)", () => {
  test("the discovery scan is non-empty (anti-vacuity)", () => {
    const executed = executedPopulation()
    expect(
      executed.size,
      "no suite discovered anything — every assertion below would pass",
    ).toBeGreaterThan(3000)
    expect(trackedTests().size).toBeGreaterThan(3000)
  })

  /** The inventory gap, pinned as a number so it shrinks deliberately instead of
   *  being rediscovered. NOT a coverage failure: the vitest lane is gated. */
  test("the web `.test.tsx` accounting gap stays at its measured size", () => {
    const executed = executedPopulation()
    const gap = [...trackedTests()].filter((p) => isWebTsx(p) && !executed.has(p))
    expect(
      gap.length,
      "web tsx inventory gap grew — widen the matcher or shrink this",
    ).toBeLessThanOrEqual(33)
  })

  test("every test cited as fc evidence is executed, or its feature declares otherwise", async () => {
    const features = await loadFeaturesStrict(FEATURES_DIR)
    const executed = executedPopulation()
    const offenders: string[] = []
    for (const { feature } of features) {
      const cited = [
        ...feature.evidence.tests.unit,
        ...feature.evidence.tests.integration,
        ...feature.evidence.tests.contract,
      ]
      // Only files a runner would ever pick up. A cited barrel or harness
      // (`tests/smoke/index.ts`, `tests/unit/_harness.ts`) is a MODULE the suites
      // import, not a suite — asking whether it is "executed" is the wrong
      // question, and the first version of this guard flagged eight features for
      // it. The rule is narrowed rather than the eight being allowlisted.
      const unexecuted = cited.filter(
        (p) => /\.test\.(ts|tsx)$/.test(p) && !executed.has(p) && !isWebTsx(p),
      )
      if (unexecuted.length === 0) continue
      // Citing an out-of-band test is allowed — the feature just has to SAY SO.
      //
      // Two narrowings, both from this guard getting it wrong first:
      //
      //   - accepting ANY `deliberate_hold` excused the one case it was written to
      //     catch. `objective-goal-continuation-live` holds on HEADLESS/BATCH SCOPE,
      //     which has nothing to do with execution.
      //   - reading only the hold missed the declaration entirely once it was
      //     written where a reader would actually find it, which is `notes`.
      //
      // So the whole human-readable body counts: purpose, notes, and the hold. The
      // requirement is that a READER of the catalogue can tell, not that the fact is
      // filed in one particular field.
      const body = [
        feature.purpose,
        feature.notes ?? "",
        feature.deliberate_hold?.reason ?? "",
        feature.deliberate_hold?.promotion_path ?? "",
      ].join("\n")
      if (declaresOutOfBand(body)) continue
      offenders.push(
        `${feature.id}: ${unexecuted
          .map((u) => {
            const dir = Object.keys(OUT_OF_BAND_DIRS).find((d) => u.startsWith(d))
            return dir === undefined ? u : `${u} [${OUT_OF_BAND_DIRS[dir]}]`
          })
          .join(", ")}`,
      )
    }
    expect(
      offenders.sort(),
      "cited as proof but in no execution population, and the feature does not declare it — enroll the test, or record the hold",
    ).toEqual([])
  }, 60_000)
})
