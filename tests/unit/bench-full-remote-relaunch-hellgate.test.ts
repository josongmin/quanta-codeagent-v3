/**
 * Hellgate: full-remote caller-level relaunch retry.
 *
 * RCA (2026-06-18): a full-remote run is held by ONE blocking ssh on a SPOT box.
 * Two loss modes wipe the ENTIRE run, identically, as an all-empty result:
 *   - AWS spot reclaim (box terminated mid-run), and
 *   - ssh-255: under grading CPU saturation sshd misses keepalive ⇒ the blocking
 *     ssh is torn down before report.json exists.
 * The executor comment promised "CALLER-LEVEL retry" but the CLI never did it,
 * so a single blip silently lost 53- and 4-instance shards. `runWithRelaunch`
 * mints a FRESH box per empty/thrown attempt, bounded so a broken config can't
 * loop forever, and never retries a dry-run (its verdict-less result is intended).
 *
 * Red-on-injection: set maxRelaunch=0 (or drop the empty-check) and TEST-2's
 * "recovers after a transient empty" assertion fails — total loss returns.
 */
import { describe, expect, test } from "bun:test"
import {
  type FullRemoteResult,
  isEmptyFullRemoteResult,
  runWithRelaunch,
} from "../../src/apps/bench/remote/full"

const ok = (resolved: string[]): FullRemoteResult => ({ resolved, unresolved: [], reportPath: "/x" })
const empty = (): FullRemoteResult => ({ resolved: [], unresolved: [], errored: [], emptyPatch: [] })

describe("isEmptyFullRemoteResult", () => {
  test("all-empty ⇒ true; any verdict ⇒ false; dry-run ⇒ false (not a loss)", () => {
    expect(isEmptyFullRemoteResult(empty())).toBe(true)
    expect(isEmptyFullRemoteResult(ok(["a__1"]))).toBe(false)
    expect(isEmptyFullRemoteResult({ unresolved: ["b__2"] })).toBe(false)
    expect(isEmptyFullRemoteResult({ emptyPatch: ["c__3"] })).toBe(false)
    // dry-run carries no verdicts but must NOT be treated as a lost run
    expect(isEmptyFullRemoteResult({ dryRun: true, plan: ["..."] })).toBe(false)
  })
})

describe("runWithRelaunch — fresh box per empty/thrown attempt", () => {
  test("clean first run ⇒ exactly ONE box minted, no relaunch", async () => {
    let made = 0
    const res = await runWithRelaunch(
      () => {
        made += 1
        return { run: async () => ok(["a__1"]) }
      },
      { maxRelaunch: 2 },
    )
    expect(made).toBe(1)
    expect(res.attempts).toBe(1)
    expect(res.resolved).toEqual(["a__1"])
  })

  test("recovers after a transient empty: empty → empty → success (3 fresh boxes)", async () => {
    const outcomes = [empty(), empty(), ok(["a__1", "b__2"])]
    let made = 0
    const res = await runWithRelaunch(
      () => {
        const i = made++
        return { run: async () => outcomes[i]! }
      },
      { maxRelaunch: 2 },
    )
    expect(made).toBe(3) // relaunched twice
    expect(res.attempts).toBe(3)
    expect(res.resolved).toEqual(["a__1", "b__2"]) // ...and banked the recovered run
  })

  test("a THROWN attempt (launch failure) is retried, not fatal", async () => {
    const runs: Array<() => Promise<FullRemoteResult>> = [
      async () => {
        throw new Error("no spot capacity")
      },
      async () => ok(["a__1"]),
    ]
    let made = 0
    const res = await runWithRelaunch(() => ({ run: runs[made++]! }), { maxRelaunch: 2 })
    expect(made).toBe(2)
    expect(res.resolved).toEqual(["a__1"])
  })

  test("bounded: all-empty exhausts at maxRelaunch+1 attempts, never loops forever", async () => {
    let made = 0
    const res = await runWithRelaunch(
      () => {
        made += 1
        return { run: async () => empty() }
      },
      { maxRelaunch: 2 },
    )
    expect(made).toBe(3) // 1 + 2 relaunches, then stop
    expect(res.attempts).toBe(3)
    expect(isEmptyFullRemoteResult(res)).toBe(true) // gives up honestly (no fake verdicts)
  })

  test("maxRelaunch=0 ⇒ single attempt, an empty stays lost (the pre-fix behavior)", async () => {
    let made = 0
    const res = await runWithRelaunch(
      () => {
        made += 1
        return { run: async () => empty() }
      },
      { maxRelaunch: 0 },
    )
    expect(made).toBe(1)
    expect(res.attempts).toBe(1)
  })

  test("dry-run short-circuits: never relaunched despite carrying no verdicts", async () => {
    let made = 0
    const res = await runWithRelaunch(
      () => {
        made += 1
        return { run: async () => ({ dryRun: true, plan: ["plan"] }) }
      },
      { maxRelaunch: 3 },
    )
    expect(made).toBe(1) // a dry-run is intentional, not a loss to retry
    expect(res.dryRun).toBe(true)
  })
})
