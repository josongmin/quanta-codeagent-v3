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

    // Root signalled FIRST (stops new forks before we enumerate descendants).
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
})
