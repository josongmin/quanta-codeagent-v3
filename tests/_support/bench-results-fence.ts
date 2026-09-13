/**
 * The POLICY half of the test-suite fence around `QUANTA_BENCH_RESULTS_DIR`.
 *
 * `tests/setup.ts` (bun's preload) applies this; everything decidable lives here
 * as a pure function so it can be driven over hostile inputs by a unit test.
 * A fence that only exists as four lines inside a preload file is a fence nobody
 * can test — and this one already failed once in exactly the way an untested
 * fence fails.
 *
 * ## What is being fenced
 *
 * `writeReport` / `writeArtifacts` fan out to `mirrorReportToSsot`, whose sink
 * defaults to the operator's LIVE `~/.quanta/bench/results` corpus — the trove
 * the leaderboard dashboard reads. Any test that writes a report therefore
 * deposits synthetic runs into real benchmark data. The aug-22 incident: one
 * suite left 80 artifacts there, 32 of them stamped
 * `benchmarkSuite:"terminal-bench"`, i.e. fabricated Terminal-Bench runs sitting
 * in the leaderboard corpus.
 *
 * ## Why the original guard was not enough
 *
 * It was `if (process.env.QUANTA_BENCH_RESULTS_DIR === undefined) { redirect }`.
 * Two ways through it, both reachable without anybody doing anything odd:
 *
 *  1. **Blank.** `QUANTA_BENCH_RESULTS_DIR=""` is not `undefined`, so the guard
 *     stood down — and `benchResultsDir()` treats a blank override as absent and
 *     falls back to the LIVE corpus. The guard handed the leak straight through.
 *  2. **Ambient.** A bench operator plausibly exports the real results dir in
 *     their own shell. The guard read that as "an explicit override, respect it"
 *     and pointed the whole suite at the live corpus.
 *
 * So the fence cannot key on "did someone set the variable". It has to key on
 * **where the value points**, which is what this module decides.
 *
 * ## The one deliberate override of operator intent
 *
 * A value that resolves to the live corpus is REDIRECTED, not honoured and not
 * refused. Honouring it is the bug. Refusing (throwing out of the preload) would
 * make an ordinary operator shell unable to run the test suite at all, which
 * trades a data-integrity failure for an availability failure and protects
 * nothing extra. Redirecting protects the corpus and keeps the suite runnable;
 * the reason is surfaced so the redirect is never silent.
 *
 * ## Every value outside scratch is redirected too (round 9)
 *
 * This fence used to honour every explicit value except the live corpus. An operator who
 * exported an ARCHIVE dir (`~/.quanta/bench/results-archive`) had test reports written
 * into it — measured, five `tmp__bench-art-*__report.json` files beside a real report
 * (round-9 audit). The quanta-home fence already keys on "is it scratch", and the two
 * fences now agree: a scratch path and the `off`/`0` sentinels are honoured; anything
 * else is redirected. A per-test dir set INSIDE a test is unaffected (the preload decides
 * once, before any test runs).
 */
import { resolve } from "node:path"
import { isScratch } from "./quanta-home-fence"

/** `QUANTA_BENCH_RESULTS_DIR` values that disable the mirror outright. */
const MIRROR_DISABLED_SENTINELS: readonly string[] = ["off", "0"]

export type BenchResultsFenceDecision =
  /** Leave the environment exactly as the caller set it. */
  | { readonly action: "accept" }
  /** Overwrite the variable with `dir`; `reason` explains why, for the log. */
  | { readonly action: "redirect"; readonly dir: string; readonly reason: string }

export interface BenchResultsFenceInput {
  /** The raw `QUANTA_BENCH_RESULTS_DIR`, exactly as read from the environment. */
  readonly configured: string | undefined
  /** Absolute path of the live SSOT corpus (`~/.quanta/bench/results`). */
  readonly liveSsotDir: string
  /** Where the suite's reports go instead. */
  readonly fallbackDir: string
  /** Roots that count as scratch (`scratchPrefixesFor(tmpdir())`). */
  readonly scratchPrefixes: readonly string[]
}

/**
 * Do two path strings name the same directory? Compared through `resolve`, so a
 * trailing slash, a `.` segment, or a relative spelling of the live corpus
 * cannot walk past the fence. Purely lexical — deliberately: the fence must
 * decide identically on a machine where neither directory exists yet, and must
 * never be defeated by the corpus simply not having been created.
 */
const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b)

export const decideBenchResultsDir = (input: BenchResultsFenceInput): BenchResultsFenceDecision => {
  const raw = input.configured
  const value = raw?.trim() ?? ""

  // Absent or blank. Blank is NOT "explicitly chosen": `benchResultsDir()` reads
  // it as absent and falls back to the live corpus, so it is a leak spelled
  // differently.
  if (value === "") {
    return {
      action: "redirect",
      dir: input.fallbackDir,
      reason:
        raw === undefined
          ? "QUANTA_BENCH_RESULTS_DIR is unset, so the report mirror would default to the live corpus"
          : "QUANTA_BENCH_RESULTS_DIR is blank, which the resolver treats as unset ⇒ the live corpus",
    }
  }

  // Mirroring disabled entirely — nothing can leak.
  if (MIRROR_DISABLED_SENTINELS.includes(value)) return { action: "accept" }

  // An explicit value that points AT the live corpus. The one case where the
  // suite overrides operator intent.
  if (sameDir(value, input.liveSsotDir)) {
    return {
      action: "redirect",
      dir: input.fallbackDir,
      reason:
        `QUANTA_BENCH_RESULTS_DIR points at the LIVE bench corpus (${input.liveSsotDir}); ` +
        "tests would deposit synthetic runs into real leaderboard data",
    }
  }

  if (isScratch(value, input.scratchPrefixes)) return { action: "accept" }
  return {
    action: "redirect",
    dir: input.fallbackDir,
    reason: `QUANTA_BENCH_RESULTS_DIR points outside scratch (${value}); test reports would land in a real directory`,
  }
}
