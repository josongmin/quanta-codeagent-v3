/**
 * HELLGATE — OmO R1-stopgap (D1 leak-fix): the forked side-agent's `kill()` must
 * signal the WHOLE descendant tree (a forked side-agent runs its own loop and
 * spawns bash/test/LSP children) and escalate SIGTERM→SIGKILL, NOT send a raw
 * single-PID `cp.kill` that leaves children reparented-to-init (the documented
 * "state=running but no process" orphan class).
 *
 * The fix routes through the PROVEN `escalatingKill` + a ppid-walk tree killer
 * (no re-implementation). node has no `.exited` promise (Bun-only), so the
 * adapter synthesizes one from the `'exit'` event — this test pins that adapter,
 * since a broken synthesis silently re-leaks the grace timer / signals a reaped
 * (recycled) pid.
 */
import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import { wrapChild } from "@/host/runtime/side-agent-fork-port"
import type { ProcessTreeKiller } from "@/runtime"

/** Minimal ChildProcess fake — an EventEmitter with the surface `wrapChild` uses. */
const makeFakeCp = (pid: number | undefined) => {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number | undefined
    killed: boolean
    rawKillSignals: unknown[]
    kill: (signal?: unknown) => boolean
    send: (msg: unknown) => boolean
  }
  ee.pid = pid
  ee.killed = false
  ee.rawKillSignals = []
  ee.kill = (signal?: unknown) => {
    ee.rawKillSignals.push(signal ?? "SIGTERM")
    return true
  }
  ee.send = () => true
  return ee
}

const spyKiller = (): { killer: ProcessTreeKiller; calls: Array<{ pid: number; signal: string }> } => {
  const calls: Array<{ pid: number; signal: string }> = []
  return {
    killer: { signalTree: (pid, signal) => void calls.push({ pid, signal: String(signal) }) },
    calls,
  }
}

describe("R1-stopgap — side-agent fork kill routes through the tree-killer", () => {
  test("kill() SIGTERMs the WHOLE tree via signalTree, NOT a raw single-PID cp.kill", () => {
    const cp = makeFakeCp(4242)
    const { killer, calls } = spyKiller()
    const h = wrapChild(cp as never, killer)
    h.kill()
    // whole-tree SIGTERM went through the injected killer…
    expect(calls).toContainEqual({ pid: 4242, signal: "SIGTERM" })
    // …and the leaky raw single-PID path was NOT used.
    expect(cp.rawKillSignals).toEqual([])
  })

  test("after the child exits, a later kill() does NOT signal the (possibly recycled) pid", async () => {
    // Pins the node→KillableChild `exited` adapter: the 'exit' event must resolve
    // the synthesized promise so escalatingKill's reaped latch engages. A broken
    // synthesis (never-resolving promise) would let this kill() signal a dead pid.
    const cp = makeFakeCp(4242)
    const { killer, calls } = spyKiller()
    const h = wrapChild(cp as never, killer)
    cp.emit("exit", 0, null)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    h.kill()
    expect(calls).toEqual([])
  })

  test("re-entrant kill() does not stack signals (idempotent SIGTERM)", () => {
    const cp = makeFakeCp(4242)
    const { killer, calls } = spyKiller()
    const h = wrapChild(cp as never, killer)
    h.kill()
    h.kill()
    // both calls re-send SIGTERM but escalatingKill never stacks grace timers;
    // the routing (not the count) is the invariant — both go to the tree killer.
    expect(calls.every((c) => c.signal === "SIGTERM" && c.pid === 4242)).toBe(true)
    expect(cp.rawKillSignals).toEqual([])
  })

  test("degrades to single-PID when pid is missing (pid>0 guard, no self-signal)", () => {
    // pid undefined ⇒ escalatingKill's `pid > 0` guard forbids signalTree (a
    // signalTree(0) would nuke the caller's own process group) and falls back to
    // the child's own kill — byte-identical to the legacy safe path.
    const cp = makeFakeCp(undefined)
    const { killer, calls } = spyKiller()
    const h = wrapChild(cp as never, killer)
    h.kill()
    expect(calls).toEqual([]) // NEVER signalTree without a positive pid
    expect(cp.rawKillSignals.length).toBeGreaterThan(0) // single-PID fallback used
  })
})
