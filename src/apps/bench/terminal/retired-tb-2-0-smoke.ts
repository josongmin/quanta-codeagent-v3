/**
 * TB21-06 (SC-1/SC-3) — the RETIRED Terminal-Bench **2.0** smoke set, preserved
 * as EVIDENCE.
 *
 * ## Why this file exists
 *
 * The 2.0 smoke authority was a shell driver (`tools/tb-smoke/run-tb-smoke.sh`)
 * that hard-coded a hand-picked task list and drove the harness directly with the
 * retired unversioned dataset shorthand. TB21-06 deletes that driver: the 2.1 smoke authority is the
 * revision-bound canary manifest (`./canary.ts`) entered through
 * `quanta-bench terminal run --tasks canary`.
 *
 * Deleting the driver would, however, have destroyed a LIVE contract: the canary
 * hellgate's disjointness rail ("do not reuse the TB2.0 smoke list") read that
 * script's bytes. Per the ticket's stop rule the contract is MIGRATED here
 * first, verbatim and with provenance, so the rail keeps binding real data
 * instead of a memory.
 *
 * ## What this file is NOT
 *
 * It is **not** a target set and must never become one. Every name below was
 * chosen against the 2.0 dataset revision and justified by 2.0-era competitor
 * pass-rates and 2.0-era failure attribution — exactly the contamination the
 * 2.1 campaign forbids ("No task is called a guard or winnable based on TB2.0
 * results"). The only sanctioned consumers are rails that assert DISJOINTNESS.
 * A tally of the 2.1 task catalog shows the overlap is real (several of these
 * names still exist in 2.1), which is precisely why an explicit refusal is
 * needed rather than silence.
 */

/** The retired 2.0 smoke set, transferred verbatim from the deleted driver. */
export interface RetiredTb20Smoke {
  /** The deleted file these names came from. */
  readonly sourcePath: string
  /** The last commit at which `sourcePath` existed — where the bytes are
   *  recoverable (git is the archive; no copy of the driver is kept). */
  readonly retiredAtCommit: string
  /** Why the whole set is retired rather than re-pointed at 2.1. */
  readonly retiredBecause: string
  /** 2.0 "stable guard" tasks (competitor 100% + both our arms green). */
  readonly guard: readonly string[]
  /** 2.0 lever-regression witnesses (competitor 100%, our lever arm red). */
  readonly leverRegression: readonly string[]
  /** 2.0 "winnable" targets (our fail ∩ competitor pass). */
  readonly targets: readonly string[]
}

export const RETIRED_TB_2_0_SMOKE: RetiredTb20Smoke = {
  sourcePath: "tools/tb-smoke/run-tb-smoke.sh",
  retiredAtCommit: "7bf5014ae894eac21fce71bafe74502b51c7983e",
  retiredBecause:
    "Chosen against the Terminal-Bench 2.0 dataset revision and justified by 2.0 leaderboard " +
    "pass-rates and 2.0 failure attribution. The 2.1 task set and its competitor field differ, " +
    "so every guard/winnable label here is a stale prior. The 2.1 smoke authority is the " +
    "revision-bound canary manifest in ./canary.ts.",
  guard: ["fix-git", "regex-log"],
  leverRegression: ["extract-elf", "path-tracing", "headless-terminal"],
  targets: [
    "polyglot-c-py",
    "rstan-to-pystan",
    "sam-cell-seg",
    "pytorch-model-recovery",
    "model-extraction-relu-logits",
  ],
} as const

/** Flat view — the union the disjointness rails compare against. */
export const retiredTb20SmokeTaskNames = (): readonly string[] => [
  ...RETIRED_TB_2_0_SMOKE.guard,
  ...RETIRED_TB_2_0_SMOKE.leverRegression,
  ...RETIRED_TB_2_0_SMOKE.targets,
]
