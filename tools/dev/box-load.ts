/**
 * How busy is this box, and should a load-sensitive gate start yet.
 *
 * WHY THIS EXISTS — measured, twice, and both times misattributed.
 *
 * The `real-toolchain-e2e` gate drives a real rust-analyzer. Its own source
 * already carries the scar: "under the full parallel suite it gets CPU-starved
 * and returns empty hover ⇒ flake", which is why it was moved to a serial
 * opt-in lane. But the serial lane runs inside the SAME campaign, immediately
 * after a 30-chunk full suite — so the contention it was moved to escape is
 * exactly what it starts in.
 *
 * Then a foreign process made it worse in a way no amount of gate design could
 * see: another session on this machine had left 40 orphaned busy-loop shells
 * running for nine and a half hours, holding the 16-core box at load 52. The
 * campaign's rust-analyzer tests failed. MEASURED, same commit, same command:
 * at load 52 the file goes 1 pass / 1 fail; at load 3.9 it goes 2 pass in 5.2s.
 *
 * The cost of that red was not the gate — it was the ATTRIBUTION. Nothing in
 * the output said the box was saturated, so a 45-minute run looked like a code
 * defect and was investigated as one.
 *
 * So: no timeout was inflated. A gate that says it needs a quiet box waits for
 * one, within a bounded budget; and every gate records the load it ran under,
 * so a failure carries the one fact that decides whether it is even about the
 * code.
 *
 * THRESHOLD. Not a tuned number: per-core run-queue length of 1.0 is the
 * definition of a box that is not oversubscribed. Above it, runnable work
 * exceeds the CPUs to run it, and a real language server indexing a crate is
 * competing rather than working.
 */

import { cpus, loadavg } from "node:os"

/** Runnable work per CPU over the last minute. 1.0 = exactly subscribed. */
export const loadPerCore = (): number => {
  const cores = cpus().length
  return cores > 0 ? (loadavg()[0] ?? 0) / cores : 0
}

export interface QuietBoxWait {
  /** Per-core load when the wait began. */
  readonly startPerCore: number
  /** Per-core load when it ended — by settling or by running out of budget. */
  readonly endPerCore: number
  readonly waitedMs: number
  /** False when the budget ran out first: the gate runs anyway, but HOT. */
  readonly settled: boolean
}

export interface QuietBoxOptions {
  /** Above this, the box is oversubscribed. Defaults to the definition, 1.0. */
  readonly maxPerCore?: number
  readonly budgetMs: number
  readonly pollMs?: number
  /** Injected for tests. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly sample?: () => number
}

/**
 * Wait for the box to stop being oversubscribed, then report what happened.
 *
 * Deliberately NON-BLOCKING as a policy: it never refuses to run the gate. A
 * verification rail that can be stopped by unrelated load on the host is a rail
 * that cannot be used on a working machine. It buys the quiet if the quiet is
 * coming, and otherwise hands the caller the number to report.
 */
export const waitForQuietBox = async (options: QuietBoxOptions): Promise<QuietBoxWait> => {
  const maxPerCore = options.maxPerCore ?? 1
  const pollMs = options.pollMs ?? 2_000
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const sample = options.sample ?? loadPerCore

  const started = now()
  const startPerCore = sample()
  let current = startPerCore
  while (current > maxPerCore) {
    if (now() - started >= options.budgetMs) {
      return { startPerCore, endPerCore: current, waitedMs: now() - started, settled: false }
    }
    await sleep(pollMs)
    current = sample()
  }
  return { startPerCore, endPerCore: current, waitedMs: now() - started, settled: true }
}

/** One line, for the gate log and for the failure that needs explaining. */
export const describeQuietBoxWait = (wait: QuietBoxWait): string =>
  wait.settled
    ? wait.waitedMs === 0
      ? `box quiet (load/core ${wait.startPerCore.toFixed(2)})`
      : `waited ${Math.round(wait.waitedMs / 1000)}s for a quiet box ` +
        `(load/core ${wait.startPerCore.toFixed(2)} → ${wait.endPerCore.toFixed(2)})`
    : `RAN HOT — load/core still ${wait.endPerCore.toFixed(2)} after ` +
      `${Math.round(wait.waitedMs / 1000)}s; a failure below may be contention, not code`

/**
 * How long to wait, with a TEST SEAM.
 *
 * A fixture that drives the real runner must be able to prove the wait is
 * WIRED without paying it: the first version of that test made a synthetic
 * gate wait on this machine's actual load and blew a 15s test timeout after
 * 58 seconds inside a campaign — a test whose duration is a function of what
 * else the box is doing.
 *
 * Production never sets this. When it is set, the resulting wait is still
 * printed, so a zero budget shows up as `RAN HOT` rather than as silence.
 */
export const quietBoxBudgetMs = (
  env: Readonly<Record<string, string | undefined>>,
  fallbackMs: number,
): number => {
  // NESTED. A campaign or gate started from inside a shard worker is a test
  // fixture, and a fixture must not wait on the machine: twice in one
  // afternoon a fixture's duration became a function of what else this box was
  // doing — one gate fixture took 58 seconds against a 15s timeout, and after
  // that was fixed two campaign lease fixtures did the same — each failing a
  // cold campaign at a different chunk while passing standalone every time.
  //
  // `QUANTA_TEST_TIMEOUT_SCALE` is set by `run-test-shards` on every worker and
  // by nothing else, so it answers "am I inside the test rail" exactly, with no
  // source-text guessing about which files spawn what.
  if (env.QUANTA_TEST_TIMEOUT_SCALE !== undefined) return 0
  const raw = env.QUANTA_QUIET_BOX_BUDGET_MS
  if (raw === undefined) return fallbackMs
  // STRICT, because `Number.parseInt` is not: it reads "1e9999" as 1, which
  // would turn a typo into a one-millisecond budget — the wait disabled, in
  // silence, by a value that looks enormous.
  if (!/^\d+$/.test(raw)) return fallbackMs
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) ? parsed : fallbackMs
}
