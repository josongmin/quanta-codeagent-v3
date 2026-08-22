/**
 * Hellgate for the test-suite fence around `QUANTA_BENCH_RESULTS_DIR`.
 *
 * The fence exists because the report mirror's DEFAULT sink is the operator's
 * live `~/.quanta/bench/results` corpus, so a test that writes a report writes
 * into real leaderboard data (aug-22: 80 synthetic artifacts, 32 of them
 * fabricated Terminal-Bench runs). The original guard keyed on "is the variable
 * undefined", which two ordinary states walked straight through — a blank value
 * and an operator whose shell already exports the real corpus.
 *
 * TEETH:
 *  - the two historical bypasses (blank, ambient-live) are each pinned;
 *  - a lexical dodge of the live corpus (trailing slash, `.` segment) is pinned;
 *  - the fence is proven NOT to be a blanket override: legitimate per-test dirs
 *    and the mirror-disabling sentinels survive untouched — a fence that
 *    redirected everything would pass a "no leak" assertion while destroying the
 *    tests that assert on their own output dir;
 *  - the WIRING is asserted against the real `tests/setup.ts` bytes, because a
 *    perfect policy module that the preload does not call fences nothing.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { decideBenchResultsDir } from "../_support/bench-results-fence"

const LIVE = "/Users/dev/.quanta/bench/results"
const FALLBACK = "/tmp/quanta-bench-test-results"

const decide = (configured: string | undefined) =>
  decideBenchResultsDir({ configured, liveSsotDir: LIVE, fallbackDir: FALLBACK })

describe("bench-results fence — policy", () => {
  test("BYPASS 1 (historical): an unset variable is redirected, not accepted", () => {
    const d = decide(undefined)
    expect(d.action).toBe("redirect")
    expect(d.action === "redirect" && d.dir).toBe(FALLBACK)
  })

  test("BYPASS 2 (historical): a BLANK variable is redirected — blank resolves to the live corpus", () => {
    for (const blank of ["", "   ", "\t"]) {
      const d = decide(blank)
      expect(d.action, `blank spelling ${JSON.stringify(blank)} slipped through`).toBe("redirect")
      expect(d.action === "redirect" && d.reason).toContain("blank")
    }
  })

  test("BYPASS 3 (historical): an AMBIENT value pointing at the live corpus is redirected", () => {
    const d = decide(LIVE)
    expect(d.action).toBe("redirect")
    expect(d.action === "redirect" && d.dir).toBe(FALLBACK)
    expect(d.action === "redirect" && d.reason).toContain("LIVE bench corpus")
  })

  test("a lexical dodge of the live corpus does not walk past the fence", () => {
    for (const dodge of [`${LIVE}/`, `${LIVE}/.`, `${LIVE}/sub/..`, `${LIVE}//`]) {
      expect(decide(dodge).action, `dodge ${dodge} slipped through`).toBe("redirect")
    }
  })

  test("PAIRED CONTROL — the fence is not a blanket override", () => {
    // A per-test directory is the normal, correct case and must survive intact.
    expect(decide("/tmp/my-test-run-42").action).toBe("accept")
    // A path that merely SHARES A PREFIX with the corpus is a different directory.
    expect(decide(`${LIVE}-archive`).action).toBe("accept")
    expect(decide("/Users/dev/.quanta/bench/results-old").action).toBe("accept")
    // The mirror-disabling sentinels must not be rewritten into a real directory,
    // which would silently re-enable mirroring for every test that turned it off.
    expect(decide("off").action).toBe("accept")
    expect(decide("0").action).toBe("accept")
    expect(decide(" off ").action).toBe("accept")
  })
})

describe("bench-results fence — wiring", () => {
  const setupSource = readFileSync(resolve(import.meta.dir, "../setup.ts"), "utf8")

  test("tests/setup.ts applies the fence rather than re-implementing the rule", () => {
    expect(setupSource).toContain("decideBenchResultsDir")
    // The historical guard shape must be gone: keying on `=== undefined` is the
    // exact bug this fence replaced, and leaving it behind would let a future
    // edit "restore" it while the policy module sits unused.
    expect(setupSource).not.toContain("QUANTA_BENCH_RESULTS_DIR === undefined")
  })

  test("the preload's redirect target is inside the OS temp dir, never the corpus", () => {
    // The fallback is chosen by the preload, so the policy test above cannot see
    // it. Pin it here: a fallback that resolved into the real corpus would make
    // every assertion above vacuous.
    const fallback = join(tmpdir(), "quanta-bench-test-results")
    expect(setupSource).toContain("quanta-bench-test-results")
    expect(resolve(fallback).startsWith(resolve(tmpdir()))).toBe(true)
  })

  /**
   * BEHAVIOURAL proof, not a source-text one. The two assertions above would
   * still pass if the fence were called and its answer discarded, so this test
   * runs a REAL report-writing suite in a child `bun test` whose environment is
   * the exact hostile shape — a quanta home and a `QUANTA_BENCH_RESULTS_DIR`
   * both pointing at the same "live" corpus — and looks at what landed on disk.
   *
   * The negative and the positive are asserted together and DIFFERENTIALLY: an
   * accepted directory must receive the mirror files that the corpus-pointed one
   * does not. Without that pairing, "0 files in the corpus" is equally
   * consistent with the fence working and with the mirror being switched off.
   */
  test("END TO END — a child suite pointed at the corpus writes nothing there, but writes to an accepted dir", () => {
    const home = mkdtempSync(join(tmpdir(), "quanta-fence-home-"))
    const corpus = join(home, "bench", "results")
    mkdirSync(corpus, { recursive: true })
    const accepted = mkdtempSync(join(tmpdir(), "quanta-fence-accept-"))
    const victim = "tests/unit/bench-write-artifacts.test.ts"

    const run = (resultsDir: string) => {
      const proc = Bun.spawnSync(["bun", "test", victim], {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          QUANTA_CONFIG_DIR: home,
          QUANTA_BENCH_RESULTS_DIR: resultsDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (proc.exitCode !== 0) {
        throw new Error(
          `child suite failed (exit ${proc.exitCode}):\n${new TextDecoder().decode(proc.stderr)}`,
        )
      }
    }

    run(corpus)
    expect(readdirSync(corpus), "the fence let a child suite write into the live corpus").toEqual(
      [],
    )

    // PAIRED CONTROL — the same suite, same child-process machinery, an ACCEPTED
    // directory. Proves the mirror really fires, so the empty corpus above is the
    // fence at work and not a dead write path.
    run(accepted)
    expect(readdirSync(accepted).length).toBeGreaterThan(0)

    rmSync(home, { recursive: true, force: true })
    rmSync(accepted, { recursive: true, force: true })
  }, 120_000)
})
