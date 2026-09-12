/**
 * ★ HELLGATE — `killProcessTree` must be bounded in TIME and in OBSERVATIONS,
 * and must never signal a group it cannot prove is ours.
 *
 * MEASURED DEFECT (2026-09-12), all three in the same drain path:
 *
 *  1. `waitForEmptyGroup` polled every 50ms for up to 60s SIGTERM grace + 10s
 *     SIGKILL grace. That is up to ~1,400 `ps` spawns for ONE group, on a host
 *     that is by construction already in trouble.
 *  2. Each of those polls was `Bun.spawnSync(["ps", …])` with NO timeout. A
 *     wedged `ps` froze the event loop, so the very deadline meant to bound the
 *     kill was itself blocked behind the observation.
 *  3. `leaderIdentity` returned `undefined` for BOTH "the leader exited" and
 *     "`ps` failed", and the caller treated `undefined` as safe-to-kill. The
 *     pid-recycle guard was therefore entirely OFF whenever `ps` was
 *     unavailable — and the blast radius of getting that wrong is SIGKILL to a
 *     stranger's process tree.
 *
 * Every test here injects the clock, the signal sink and the observer, so a
 * 70-second survivor is exercised in microseconds against the REAL loop
 * arithmetic and the REAL signal sequence.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_POLL_SCHEDULE,
  type LeaderIdentity,
  type ProcessObserver,
  type ProcessSnapshot,
  pollTickCount,
} from "../../../tools/dev/process-observer"
import {
  classifyKillTarget,
  type DrainOutcome,
  KILL_TARGET_PERMITS_SIGNAL,
  type KillTargetVerdict,
  killProcessTreeOutcome,
  probeGroupFromSnapshot,
  terminateCampaignOnSignal,
} from "../../../tools/dev/test-shard-lifecycle"
import { sliceBetween } from "../_shared/slice-between"

const PGID = 4242

/** Observations a 60s TERM + 10s KILL drain is allowed to cost. */
const SNAPSHOT_CAP = 40

/** Exactly what the backoff schedule predicts: entry probe + both wait loops. */
const EXPECTED_SNAPSHOTS =
  1 +
  (pollTickCount(60_000, DEFAULT_POLL_SCHEDULE) + 1) +
  (pollTickCount(10_000, DEFAULT_POLL_SCHEDULE) + 1)

const fakeClock = () => {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      t += ms
      return Promise.resolve()
    },
  }
}

const countingObserver = (answer: (call: number) => ProcessSnapshot): ProcessObserver => {
  let calls = 0
  return {
    snapshot(): ProcessSnapshot {
      calls += 1
      return answer(calls)
    },
    identity(): LeaderIdentity {
      throw new Error("the kill loop must never take a targeted identity probe")
    },
    get calls(): number {
      return calls
    },
  }
}

const RUNNING: ProcessSnapshot = {
  kind: "ok",
  rows: [
    {
      pid: PGID,
      ppid: 1,
      pgid: PGID,
      stat: "S",
      rssKib: 4096,
      pcpu: "0.0",
      etime: "01:10:00",
      started: "Fri Sep 11 23:13:04 2026",
      comm: "/bin/sleep",
    },
  ],
}

const EMPTY: ProcessSnapshot = { kind: "ok", rows: [] }

const UNAVAILABLE: ProcessSnapshot = {
  kind: "unavailable",
  reason: "timeout",
  detail: "ps never returned",
}

const harness = (answer: (call: number) => ProcessSnapshot) => {
  const observer = countingObserver(answer)
  const clock = fakeClock()
  const signals: string[] = []
  return {
    observer,
    clock,
    signals,
    deps: {
      observer,
      groupExists: () => true,
      signal: (pgid: number, signal: NodeJS.Signals) => signals.push(`${pgid}:${signal}`),
      now: clock.now,
      sleep: clock.sleep,
    },
  }
}

describe("killProcessTree — bounded in time AND in observations", () => {
  test("★ an observer that never returns still finishes on the declared deadline, typed", async () => {
    // "Never returns" is what the bounded observer converts into
    // `unavailable/timeout`; the loop must then keep its own deadline rather
    // than waiting for an answer that will not come.
    const h = harness(() => UNAVAILABLE)
    const outcome = await killProcessTreeOutcome(PGID, {
      termGraceMs: 60_000,
      killGraceMs: 10_000,
      deps: h.deps,
    })

    expect(outcome).toEqual({
      kind: "unobservable",
      reason: "timeout",
      detail: "ps never returned",
    })
    // Not "emptied" (a false clean drain) and not "survived" (a false claim
    // that we watched it refuse SIGKILL).
    expect(outcome.kind).not.toBe("emptied")
    expect(h.clock.now()).toBe(70_000) // exactly termGrace + killGrace, never more
    expect(h.observer.calls).toBe(EXPECTED_SNAPSHOTS)
    expect(h.observer.calls).toBeLessThanOrEqual(SNAPSHOT_CAP)
    // ANTI-VACUUM FLOOR — it genuinely polled; a loop that gave up at once
    // would also be "under the cap".
    expect(h.observer.calls).toBeGreaterThan(10)
  })

  test("★ a 70-second survivor costs ~37 observations, where the flat poll cost ~1,400", async () => {
    const h = harness(() => RUNNING)
    const outcome = await killProcessTreeOutcome(PGID, {
      termGraceMs: 60_000,
      killGraceMs: 10_000,
      deps: h.deps,
    })

    expect(outcome).toEqual({ kind: "survived" })
    expect(h.signals).toEqual([`${PGID}:SIGTERM`, `${PGID}:SIGKILL`])
    expect(h.observer.calls).toBe(EXPECTED_SNAPSHOTS)
    expect(h.observer.calls).toBeLessThanOrEqual(SNAPSHOT_CAP)
    // The pre-fix cost of the same 70 seconds, for the record.
    expect(70_000 / DEFAULT_POLL_SCHEDULE.initialMs).toBe(1_400)
    expect(h.observer.calls * 30).toBeLessThan(1_400)
    expect(h.clock.now()).toBe(70_000)
  })

  test("a group that dies during the TERM grace is emptied, and SIGKILL is never sent", async () => {
    // PAIRED CONTROL for the survivor case: the same loop, a group that goes.
    const h = harness((call) => (call <= 3 ? RUNNING : EMPTY))
    const outcome = await killProcessTreeOutcome(PGID, {
      termGraceMs: 60_000,
      killGraceMs: 10_000,
      deps: h.deps,
    })

    expect(outcome).toEqual({ kind: "emptied" })
    expect(h.signals).toEqual([`${PGID}:SIGTERM`])
    expect(h.observer.calls).toBe(4)
    // Noticed in 150ms of the 60s grace — backoff must not blunt the fast case.
    expect(h.clock.now()).toBe(150)
  })

  test("an already-empty group is neither signalled nor observed", async () => {
    // The kernel's `kill(-pgid, 0)` is the fast path; a forgotten group costs
    // ZERO spawns, which is every tick of a healthy campaign.
    const h = harness(() => {
      throw new Error("must not observe a group the kernel has forgotten")
    })
    const outcome = await killProcessTreeOutcome(PGID, {
      deps: { ...h.deps, groupExists: () => false },
    })

    expect(outcome).toEqual({ kind: "emptied" })
    expect(h.signals).toEqual([])
    expect(h.observer.calls).toBe(0)
  })

  test("a seeded snapshot is spent as the entry probe instead of a fresh spawn", async () => {
    const h = harness(() => EMPTY)
    const outcome = await killProcessTreeOutcome(PGID, { deps: h.deps, seedSnapshot: RUNNING })

    // The seed said RUNNING, so the entry probe could not short-circuit…
    expect(h.signals).toEqual([`${PGID}:SIGTERM`])
    // …and the observer was consulted only for the POLL, not for the entry.
    expect(h.observer.calls).toBe(1)
    expect(outcome).toEqual({ kind: "emptied" })
  })

  test("an unreadable table reads as 'still there', never as 'drained'", () => {
    expect(probeGroupFromSnapshot(UNAVAILABLE, PGID).kind).toBe("unobservable")
    expect(probeGroupFromSnapshot(RUNNING, PGID).kind).toBe("holds")
    expect(probeGroupFromSnapshot(EMPTY, PGID).kind).toBe("empty")
    // Zombies hold nothing: a group of them is drained, not "survived SIGKILL".
    const zombies = RUNNING.kind === "ok" ? RUNNING.rows.map((r) => ({ ...r, stat: "Z" })) : []
    expect(zombies).toHaveLength(1) // ANTI-VACUUM FLOOR: an empty list is trivially "empty"
    expect(probeGroupFromSnapshot({ kind: "ok", rows: zombies }, PGID).kind).toBe("empty")
  })
})

describe("classifyKillTarget — 'no evidence' is not permission", () => {
  const identity = (value: string): LeaderIdentity => ({ kind: "identity", value })
  const exited: LeaderIdentity = { kind: "leader-exited" }
  const unknown: LeaderIdentity = {
    kind: "unknown",
    reason: "timeout",
    detail: "ps never returned",
  }

  test("the same live leader is OURS", () => {
    expect(classifyKillTarget(identity("t1 bun"), identity("t1 bun"))).toEqual({ kind: "ours" })
  })

  test("a leader that has exited is safe to kill — anything left is our descendant", () => {
    expect(classifyKillTarget(identity("t1 bun"), exited)).toEqual({ kind: "leader-exited" })
    expect(classifyKillTarget(exited, exited)).toEqual({ kind: "leader-exited" })
  })

  test("★ a CONFIRMED different leader is a recycled pid — abandon, never signal", () => {
    const verdict = classifyKillTarget(identity("t1 bun"), identity("t2 someone-else"))
    expect(verdict.kind).toBe("recycled")
    expect(KILL_TARGET_PERMITS_SIGNAL[verdict.kind]).toBe(false)
  })

  test("★ unknown at KILL time is unverified — the guard must not fail open", () => {
    const verdict = classifyKillTarget(identity("t1 bun"), unknown)
    expect(verdict.kind).toBe("unverified")
    expect(KILL_TARGET_PERMITS_SIGNAL[verdict.kind]).toBe(false)
    expect(verdict.kind === "unverified" && verdict.detail).toContain("kill time")
  })

  test("★ unknown at SPAWN time is unverified even against a live leader", () => {
    // The subtler half: `ps` failed when the worker started, so there is no
    // recorded identity to compare a live stranger against.
    const verdict = classifyKillTarget(unknown, identity("t2 someone-else"))
    expect(verdict.kind).toBe("unverified")
    expect(verdict.kind === "unverified" && verdict.detail).toContain("spawn time")
  })

  test("unknown on BOTH sides is unverified", () => {
    expect(classifyKillTarget(unknown, unknown).kind).toBe("unverified")
  })

  test("a leader that appeared where none was recorded is unverified", () => {
    expect(classifyKillTarget(exited, identity("t2 someone-else")).kind).toBe("unverified")
  })

  test("DRIFT GUARD — every recorded x current pair is classified, and only 'ours'/'leader-exited' may signal", () => {
    const kinds: readonly LeaderIdentity[] = [identity("A"), identity("B"), exited, unknown]
    const seen = new Set<KillTargetVerdict["kind"]>()
    let permitted = 0
    for (const recorded of kinds) {
      for (const current of kinds) {
        const verdict = classifyKillTarget(recorded, current)
        expect(Object.hasOwn(KILL_TARGET_PERMITS_SIGNAL, verdict.kind)).toBe(true)
        seen.add(verdict.kind)
        if (KILL_TARGET_PERMITS_SIGNAL[verdict.kind]) permitted += 1
        // A signal is permitted ONLY when nothing unknown was involved.
        if (recorded.kind === "unknown" || current.kind === "unknown") {
          expect(KILL_TARGET_PERMITS_SIGNAL[verdict.kind]).toBe(false)
        }
      }
    }
    // ANTI-VACUUM FLOOR — the matrix really produced all four verdicts and a
    // real mix of permit/refuse, not a uniform answer that trivially passes.
    expect([...seen].sort()).toEqual(["leader-exited", "ours", "recycled", "unverified"])
    // MEASURED over the 4x4 matrix: exactly 5 of 16 pairs may be signalled —
    // A/A, B/B (ours) and A/exited, B/exited, exited/exited (leaderless).
    expect(permitted).toBe(5)
    expect(Object.keys(KILL_TARGET_PERMITS_SIGNAL).sort()).toEqual([
      "leader-exited",
      "ours",
      "recycled",
      "unverified",
    ])
  })
})

/**
 * ★ The INTERRUPT path released the lane with unaccounted survivors.
 *
 * `lease-quarantine.ts` exists because "both campaign owners … call
 * `lease?.release()` unconditionally" on a failed drain. The `finally` halves
 * were fixed; the signal halves were not. MEASURED with a registry reporting
 * `drained:false, groups:[{pgid:999901}]`:
 *
 *   SIGNAL path   leaseReleased=true   quarantineFileExists=false
 *   finally path                       quarantineFileExists=true
 *
 * One Ctrl-C then handed the next contender a lane whose ports, `$HOME` and
 * worktrees were still held — and the campaign that did it printed only `WARN`.
 *
 * The caller's `.then((code) => process.exit(code))` is the other half: the main
 * `finally` never runs, so the timing journal was never committed either. The
 * orphan journals in the shared cache are the artifact of exactly that.
 */
describe("the signal path accounts before it releases", () => {
  const undrainedRegistry = {
    cancelAll: async (): Promise<DrainOutcome> => ({
      drained: false,
      survivors: [999_901],
      abandoned: [],
      groups: [{ pgid: 999_901, leaderPid: 1, verdict: "still-running", detail: "probe" }],
    }),
  } as never

  test("accounting runs BEFORE the lease is released, and sees the surviving groups", async () => {
    let released = false
    let sawGroups = -1
    let accountedWhileHeld = false
    const code = await terminateCampaignOnSignal({
      registry: undrainedRegistry,
      runRoot: join(tmpdir(), `signal-accounting-${process.pid}`),
      signal: "SIGINT",
      log: () => {},
      accountForSurvivors: (outcome) => {
        sawGroups = outcome.groups.length
        accountedWhileHeld = !released
      },
      releaseLease: () => {
        released = true
      },
    })
    expect({ code, sawGroups, accountedWhileHeld, released }).toEqual({
      code: 130,
      sawGroups: 1,
      accountedWhileHeld: true,
      released: true,
    })
  })

  test("an accounting FAILURE still releases the lease, and says why", async () => {
    // A quarantine write that throws must not strand the lane on a signal path:
    // the record is best-effort, the release is not optional.
    const lines: string[] = []
    let released = false
    const code = await terminateCampaignOnSignal({
      registry: undrainedRegistry,
      runRoot: join(tmpdir(), `signal-accounting-fail-${process.pid}`),
      signal: "SIGTERM",
      log: (line) => lines.push(line),
      accountForSurvivors: () => {
        throw new Error("disk full")
      },
      releaseLease: () => {
        released = true
      },
    })
    expect({ code, released }).toEqual({ code: 143, released: true })
    expect(lines.join("")).toContain("signal-path accounting failed: disk full")
  })

  test("both owners hold the lane on their signal path, not only in `finally`", () => {
    // Source-shaped on purpose: a real Ctrl-C against a real campaign is not a
    // unit test. What IS checked behaviourally is the ordering above; what this
    // adds is that each owner's signal path names the quarantine at all.
    const source = (rel: string): string =>
      readFileSync(join(import.meta.dir, "..", "..", "..", rel), "utf8")
    const runner = source("tools/dev/run-test-shards.ts")
    expect(runner).toContain("accountForSurvivors: (outcome) => {")
    // The runner's hook does BOTH things the `finally` does.
    const hook = runner.slice(runner.indexOf("accountForSurvivors: (outcome) => {"))
    // `quarantineLane({` occurs twice in this file, so a window widened by a missing
    // `releaseLease:` anchor is SATISFIED by the unrelated occurrence — the hook can
    // stop quarantining and this stays green. Measured before `sliceBetween`:
    // renaming the end anchor turned a correct RED back into 17 pass / 0 fail.
    const hookBody = sliceBetween(hook, 0, "releaseLease:", {
      label: "run-test-shards.ts accountForSurvivors",
    })
    expect(hookBody).toContain("quarantineLane({")
    expect(hookBody).toContain("openJournal?.commit()")

    const campaign = source("tools/dev/verification-campaign.ts")
    const terminate = campaign.slice(campaign.indexOf("const terminate = (signal"))
    const body = sliceBetween(terminate, 0, 'process.on("SIGINT"', {
      label: "verification-campaign.ts terminate",
    })
    expect(body).toContain("quarantineLane({")
    // ...and it is written BEFORE the release, which is the whole point: the
    // kernel frees the port the instant this process exits.
    expect(body.indexOf("quarantineLane({")).toBeLessThan(body.indexOf("lease?.release()"))
  })
})
