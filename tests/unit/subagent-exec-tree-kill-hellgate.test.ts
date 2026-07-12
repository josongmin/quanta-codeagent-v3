/**
 * WS1 stopgap (jul-12 OmO absorption, 04 §5 / 05 §WS1) — exec_command must kill
 * the whole `bash -lc` process TREE, not just the shell's own pid.
 *
 * GAP: `handleExecCommand` armed its timeout + abort handlers with a bare
 * `proc.kill()` (single-PID SIGTERM). A `bash -lc "…"` that spawned a
 * grandchild (backgrounded job, a build tool that forks) left that descendant
 * ORPHANED on timeout/abort — the exact leak class the self-audit flagged as
 * higher-impact than side-agent (this is a LIVE 6-tool BASE surface).
 *
 * The canonical fix (`escalatingKill` + `defaultPpidWalkKiller`) lives in
 * @/runtime, which @/subagent may NOT import (biome slice boundary). So the kill
 * capability is INJECTED as a `makeKill` factory by the composition root
 * (`agent/tier1/subagent.ts`), exactly mirroring the existing `cwdJail`
 * structural injection. This suite pins BOTH ends:
 *
 *   §1  handler — timeout AND abort route the kill through the injected factory
 *       (real bash spawn, NO fake fork; spy killer records the signal). Revert
 *       to `proc.kill()` ⇒ RED.
 *   §2  dispatch — routeExecCommand FORWARDS makeKill to the handler (proves the
 *       middle layer is not a drop). Delete the forward ⇒ RED.
 *
 * The composition-root end (tier1 actually injects escalatingKill) is pinned by
 * `subagent-tree-kill-composition-wire-hellgate` so this correctness fix cannot
 * silently become an inert gate. `escalatingKill`'s own SIGTERM→SIGKILL ladder /
 * `defaultPpidWalkKiller`'s descendant walk stay covered by their guarded-spawn
 * / process-tree suites.
 */

import { describe, expect, test } from "bun:test"
import { escalatingKill, type ProcessTreeKiller, type TreeSignal } from "@/runtime"
import { dispatchSubagent6 } from "../../src/subagent/dispatch-6"
import { legacyKillHandle } from "../../src/subagent/exec-kill"
import { handleExecCommand, type MakeProcKill } from "../../src/subagent/handlers-6"

interface SpyKiller extends ProcessTreeKiller {
  readonly calls: ReadonlyArray<{ pid: number; signal: TreeSignal }>
}

/** Records every signalTree call AND forwards a real single-pid signal so the
 *  spawned shell actually dies fast (keeps the test ~timeout-bound, not
 *  ~sleep-bound), while still exercising the real spawn + real kill path. */
const makeSpyKiller = (): SpyKiller => {
  const calls: Array<{ pid: number; signal: TreeSignal }> = []
  return {
    calls,
    signalTree(pid: number, signal: TreeSignal): void {
      calls.push({ pid, signal })
      try {
        process.kill(pid, signal)
      } catch {
        // already dead / recycled — irrelevant to the wiring assertion
      }
    },
  }
}

/** The exact factory the composition root injects, but over a spy tree-killer. */
const spyMakeKill =
  (spy: SpyKiller): MakeProcKill =>
  (proc) =>
    escalatingKill(proc, spy)

describe("WS1 §1 — handler routes timeout/abort kills through the injected tree killer", () => {
  test("timeout ⇒ signalTree(rootPid, SIGTERM) (red-on-injection: bare proc.kill ⇒ never)", async () => {
    const spy = makeSpyKiller()
    const r = await handleExecCommand(
      { command: "sleep 5", cwd: process.cwd(), timeoutMs: 75 },
      { makeKill: spyMakeKill(spy) },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("timeout")
    expect(spy.calls.length).toBeGreaterThanOrEqual(1)
    expect(spy.calls[0]?.signal).toBe("SIGTERM")
    expect(spy.calls[0]?.pid ?? 0).toBeGreaterThan(0)
  })

  test("abort ⇒ signalTree(rootPid, SIGTERM)", async () => {
    const spy = makeSpyKiller()
    const ac = new AbortController()
    const promise = handleExecCommand(
      { command: "sleep 5", cwd: process.cwd(), timeoutMs: 60_000 },
      { makeKill: spyMakeKill(spy) },
      ac.signal,
    )
    await new Promise((res) => setTimeout(res, 50))
    ac.abort()
    const r = await promise
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("abort")
    expect(spy.calls.length).toBeGreaterThanOrEqual(1)
    expect(spy.calls[0]?.signal).toBe("SIGTERM")
    expect(spy.calls[0]?.pid ?? 0).toBeGreaterThan(0)
  })
})

describe("WS1 §2 — the dispatcher forwards makeKill to the exec handler", () => {
  test("dispatchSubagent6('exec_command', …) with makeKill ⇒ tree killer is reached (red-on-injection: no forward ⇒ never)", async () => {
    const spy = makeSpyKiller()
    const out = await dispatchSubagent6(
      "exec_command",
      { command: "sleep 5", cwd: process.cwd(), timeoutMs: 75 },
      { makeKill: spyMakeKill(spy) },
    )
    expect(out.kind).toBe("error")
    expect(spy.calls.length).toBeGreaterThanOrEqual(1)
    expect(spy.calls[0]?.signal).toBe("SIGTERM")
  })
})

// hell-audit remediation §3 — the DEFAULT fallback (`?? legacyKillHandle(proc)`,
// used when no makeKill is injected) had no direct witness. Pin its contract
// deterministically so a mutation to a no-op kill / a throwing disarm is caught.
describe("WS1 §3 — legacyKillHandle (the makeKill-absent fallback) contract", () => {
  const fakeProc = (onKill: () => void): Parameters<typeof legacyKillHandle>[0] =>
    ({ pid: 123, kill: onKill, exited: Promise.resolve(0) }) as unknown as Parameters<
      typeof legacyKillHandle
    >[0]

  test("kill() delivers a single-pid proc.kill(); disarm() is a safe no-op", () => {
    let kills = 0
    const h = legacyKillHandle(fakeProc(() => (kills += 1)))
    h.kill()
    expect(kills).toBe(1)
    h.disarm() // must NOT throw and must NOT kill
    expect(kills).toBe(1)
  })

  test("kill() swallows a throwing proc.kill (already-dead / recycled pid)", () => {
    const h = legacyKillHandle(
      fakeProc(() => {
        throw new Error("ESRCH")
      }),
    )
    expect(() => h.kill()).not.toThrow()
  })
})

// hell-audit remediation §4 — the exec `finally` calls `killHandle.disarm()` so a
// pending SIGKILL grace timer never leaks past the call. No test observed the
// call. Wrap escalatingKill's handle to count disarm() on the NORMAL-completion
// path (no timeout/abort). Red-on-injection: drop the finally disarm ⇒ 0 calls.
describe("WS1 §4 — normal completion disarms the kill handle", () => {
  test("a fast-exiting command calls killHandle.disarm() (grace-timer cleanup)", async () => {
    let disarms = 0
    const makeKill: MakeProcKill = (proc) => {
      const inner = escalatingKill(proc, makeSpyKiller())
      return {
        kill: inner.kill,
        disarm: () => {
          disarms += 1
          inner.disarm()
        },
      }
    }
    const r = await handleExecCommand(
      { command: "true", cwd: process.cwd(), timeoutMs: 5_000 },
      { makeKill },
    )
    expect(r.kind).toBe("success")
    expect(disarms).toBeGreaterThanOrEqual(1)
  })
})
