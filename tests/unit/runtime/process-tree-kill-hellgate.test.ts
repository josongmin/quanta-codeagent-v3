import { describe, expect, test } from "bun:test"
import { escalatingKill, KILL_GRACE_MS, type KillableChild } from "@/runtime"
import {
  createPpidWalkKiller,
  type ProcessTableProvider,
  type ProcessTreeKiller,
} from "@/runtime/process-tree"

/**
 * D1 — ProcessTreeKiller (jun-7-naive-impl-hardening §2.1).
 *
 * red-on-injection: a 3-level process tree (parent → child → grandchild). A
 * single-PID `proc.kill()` would only signal the parent; the whole-tree killer
 * must reach the grandchild. Reverting `escalatingKill` to the single-PID
 * `proc.kill()` (or the killer to only signalling the root) makes the
 * "grandchild received SIGTERM" assertion RED.
 */

/** A deterministic process table for the adapter — NO real `ps` in unit tests.
 *  Layout: 100 (parent) → 200 (child) → 300 (grandchild), plus an unrelated
 *  sibling tree (500 → 600) that must NOT be signalled. */
const fakeTable: ProcessTableProvider = () => [
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 200 },
  { pid: 500, ppid: 1 },
  { pid: 600, ppid: 500 },
]

/**
 * F1 — the ROOT-PID VALIDITY guard lives in the PRIMITIVE, not in the callers.
 *
 * MEASURED BLAST RADIUS (live `ps -A -o pid=,ppid=` through the shipped
 * `parsePsTable` + `createPpidWalkKiller`, recording sendSignal): `signalTree(0)`
 * signalled **596 of 596 process-table rows** — pid 1 (launchd) and the measuring
 * process itself INCLUDED. The ppid-walk reaches launchd, so pid 0 does not mean
 * "the caller's process group" (the older, understated comment): it enumerates
 * the ENTIRE process table. `safeSend` swallows every error, so it is SILENT.
 *
 * Three of the four `signalTree` call sites hand-rolled a `pid > 0` guard;
 * `runner/batch/eval/exec.ts` checked only `pid === undefined`, so 0 passed. The
 * fix puts the guard in `signalTree` itself so all four are correct BY
 * CONSTRUCTION. Red-on-injection: delete the guard and `readTable` is consulted
 * for pid 0, making the "table never read" assertions below fail.
 *
 * HONEST CLASSIFICATION (do not inflate): Bun keeps `proc.pid` POSITIVE after
 * exit (measured: 28496 live, 28496 after `await proc.exited`), so no live call
 * path is known to reach 0. This is DEFENCE IN DEPTH, not a live exploit.
 */
describe("F1 — signalTree validates rootPid in the primitive", () => {
  /** A killer whose table provider RECORDS whether it was consulted at all. */
  const probe = () => {
    const signalled: number[] = []
    let tableReads = 0
    const killer = createPpidWalkKiller({
      readTable: () => {
        tableReads++
        return fakeTable()
      },
      sendSignal: (pid) => {
        signalled.push(pid)
      },
    })
    return { killer, signalled, reads: () => tableReads }
  }

  // Every non-positive / non-integral root is refused. 0 is the catastrophic one
  // (whole process table); negatives are the POSIX "signal a process GROUP" form,
  // which this ppid-walk killer has never been designed to deliver.
  for (const bad of [0, -1, -100, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    test(`rootPid ${String(bad)} is refused: no signal sent, table never read`, () => {
      const { killer, signalled, reads } = probe()
      killer.signalTree(bad, "SIGKILL")
      expect(signalled).toEqual([]) // nothing signalled — not even the root
      expect(reads()).toBe(0) // the ppid-walk never even enumerated
    })
  }

  // PAIRED CONTROL — the guard must not be satisfied the lazy way (refusing
  // everything / short-circuiting the killer). A VALID root still reaps its
  // whole tree, and the table is still read TWICE (pre- and post-root snapshot).
  test("PAIRED CONTROL: a valid rootPid still walks and signals the whole tree", () => {
    const { killer, signalled, reads } = probe()
    killer.signalTree(100, "SIGTERM")
    expect(signalled).toEqual([100, 200, 300])
    expect(reads()).toBe(2) // pre-root + post-root snapshots both taken
  })
})

describe("createPpidWalkKiller — whole-tree signal (D1)", () => {
  test("signals the root FIRST, then every descendant (BFS), and nothing outside the tree", () => {
    const signalled: Array<{ pid: number; signal: string }> = []
    const killer = createPpidWalkKiller({
      readTable: fakeTable,
      sendSignal: (pid, signal) => {
        signalled.push({ pid, signal })
      },
    })

    killer.signalTree(100, "SIGTERM")

    // Root is still signalled FIRST (stops new forks before descendant signals).
    expect(signalled[0]).toEqual({ pid: 100, signal: "SIGTERM" })
    // Whole subtree reached — crucially the GRANDCHILD (the leak D1 fixes).
    const pidsHit = signalled.map((s) => s.pid)
    expect(pidsHit).toContain(200)
    expect(pidsHit).toContain(300)
    // The unrelated sibling tree is untouched.
    expect(pidsHit).not.toContain(500)
    expect(pidsHit).not.toContain(600)
    // Every signal was the requested one.
    expect(signalled.every((s) => s.signal === "SIGTERM")).toBe(true)
  })

  test("pre-root snapshot catches wrapper children that reparent after root SIGTERM", () => {
    const tables: ProcessTableProvider[] = [
      () => [
        { pid: 100, ppid: 1 },
        { pid: 200, ppid: 100 },
      ],
      () => [{ pid: 200, ppid: 1 }],
    ]
    const signalled: Array<{ pid: number; signal: string }> = []
    const killer = createPpidWalkKiller({
      readTable: () => {
        const next = tables.shift()
        return next ? next() : []
      },
      sendSignal: (pid, signal) => {
        signalled.push({ pid, signal })
      },
    })

    killer.signalTree(100, "SIGTERM")

    expect(signalled).toContainEqual({ pid: 100, signal: "SIGTERM" })
    expect(signalled).toContainEqual({ pid: 200, signal: "SIGTERM" })
  })

  test("post-root snapshot still catches children visible only after the root signal", () => {
    const tables: ProcessTableProvider[] = [
      () => [{ pid: 100, ppid: 1 }],
      () => [
        { pid: 100, ppid: 1 },
        { pid: 201, ppid: 100 },
      ],
    ]
    const seen: number[] = []
    const killer = createPpidWalkKiller({
      readTable: () => {
        const next = tables.shift()
        return next ? next() : []
      },
      sendSignal: (pid) => seen.push(pid),
    })

    killer.signalTree(100, "SIGKILL")

    expect(seen).toContain(100)
    expect(seen).toContain(201)
  })

  test("no-throw + idempotent: a sendSignal that throws (already-dead pid) is swallowed", () => {
    const seen: number[] = []
    const killer = createPpidWalkKiller({
      readTable: fakeTable,
      sendSignal: (pid) => {
        seen.push(pid)
        throw new Error("ESRCH: no such process")
      },
    })
    // Must not throw even though every send raises.
    expect(() => killer.signalTree(100, "SIGKILL")).not.toThrow()
    // It still attempted the whole tree (didn't abort on the first throw).
    expect(seen).toContain(300)
  })

  test("no-throw: a readTable that throws degrades to signalling the root only", () => {
    const seen: number[] = []
    const killer = createPpidWalkKiller({
      readTable: () => {
        throw new Error("ps failed")
      },
      sendSignal: (pid) => seen.push(pid),
    })
    expect(() => killer.signalTree(42, "SIGTERM")).not.toThrow()
    // Best-effort: the root still gets the signal even when enumeration fails.
    expect(seen).toEqual([42])
  })
})

describe("escalatingKill wired with a ProcessTreeKiller (D1 wiring)", () => {
  /** A fake child whose `.pid` the killer reads. Never actually spawns. */
  const fakeChild = (pid: number): KillableChild & { directKills: number } => {
    let resolveExit: ((code: number) => void) | undefined
    const child = {
      pid,
      directKills: 0,
      kill(_signal?: number | NodeJS.Signals) {
        child.directKills += 1
      },
      exited: new Promise<number>((res) => {
        resolveExit = res
      }),
      __resolve: () => resolveExit?.(0),
    }
    return child as unknown as KillableChild & { directKills: number }
  }

  test("when a killer is provided, kill() routes through signalTree(pid) — NOT proc.kill()", () => {
    const calls: Array<{ pid: number; signal: string }> = []
    const killer: ProcessTreeKiller = {
      signalTree: (pid, signal) => calls.push({ pid, signal }),
    }
    const child = fakeChild(777)
    const { kill, disarm } = escalatingKill(child, killer)
    kill()
    // SIGTERM went to the TREE, not the single child pid.
    expect(calls).toEqual([{ pid: 777, signal: "SIGTERM" }])
    expect(child.directKills).toBe(0) // proc.kill() was NOT used
    disarm()
  })

  test("the SIGKILL grace escalation also routes through signalTree", async () => {
    const calls: Array<{ pid: number; signal: string }> = []
    const killer: ProcessTreeKiller = {
      signalTree: (pid, signal) => calls.push({ pid, signal }),
    }
    const child = fakeChild(888)
    const { kill, disarm } = escalatingKill(child, killer)
    kill()
    // Wait past the grace window — child never exits, so SIGKILL must escalate.
    await Bun.sleep(KILL_GRACE_MS + 100)
    expect(calls).toEqual([
      { pid: 888, signal: "SIGTERM" },
      { pid: 888, signal: "SIGKILL" },
    ])
    disarm()
  })

  test("ABSENT killer ⇒ byte-identical fallback to proc.kill() (un-wired contract)", () => {
    const child = fakeChild(999)
    const { kill, disarm } = escalatingKill(child) // no killer
    kill()
    // Legacy path: single-PID proc.kill() used, tree killer untouched.
    expect(child.directKills).toBe(1)
    disarm()
  })

  test("pid 0 NEVER routes through signalTree (falls back to single-PID kill)", () => {
    // The blast radius is BIGGER than the old "the caller's process group" note
    // claimed: the ppid-walk climbs to launchd, so signalTree(0) enumerates the
    // WHOLE process table (measured on live `ps`: 596 of 596 rows, pid 1 and the
    // measuring process included) and `safeSend` swallows every error, so it is
    // silent. `signalTree` now refuses a non-positive root itself, so this test
    // no longer guards against a self-nuke — it pins the FALLBACK CHOICE: a
    // 0-pid child must degrade to the legacy single-PID proc.kill() (some
    // teardown) rather than to the tree killer's refusal (NO teardown).
    // Red-on-injection: drop `&& proc.pid > 0` and directKills goes to 0.
    const calls: Array<{ pid: number; signal: string }> = []
    const killer: ProcessTreeKiller = {
      signalTree: (pid, signal) => calls.push({ pid, signal }),
    }
    const child = fakeChild(0)
    const { kill, disarm } = escalatingKill(child, killer)
    kill()
    expect(calls).toEqual([]) // signalTree NEVER called with pid 0
    expect(child.directKills).toBe(1) // fell back to legacy single-PID kill
    disarm()
  })

  test("kill() AFTER the child is reaped is a no-op — no leaked SIGKILL timer (PID-reuse hazard)", async () => {
    // The bug: `bash-bg-registry` evictOldest killed an already-`completed` shell;
    // `escalatingKill` re-armed a 2s SIGKILL grace timer that nothing cleared,
    // firing `signalTree(pid, SIGKILL)` on a long-dead pid 2s later — which the OS
    // may have RECYCLED for an unrelated process. The `reaped` latch makes a
    // post-exit kill() a no-op (no signal, no timer). Red-on-injection: remove the
    // `if (reaped) return` and this sees a SIGTERM + a SIGKILL after the grace.
    const calls: Array<{ pid: number; signal: string }> = []
    const killer: ProcessTreeKiller = {
      signalTree: (pid, signal) => calls.push({ pid, signal }),
    }
    const child = fakeChild(4242)
    const { kill, disarm } = escalatingKill(child, killer)
    ;(child as unknown as { __resolve: () => void }).__resolve() // child exits / is reaped
    await Promise.resolve() // let `proc.exited.then(markReaped)` flip the latch
    await Promise.resolve()
    kill() // a LATE kill (e.g. eviction of a completed shell)
    await Bun.sleep(KILL_GRACE_MS + 100)
    expect(calls).toEqual([]) // NO SIGTERM, NO leaked SIGKILL on the dead pid
    disarm()
  })
})
