/**
 * §4.3 e2e HELLGATE — side-agent OS-PROCESS daemon V1 supervisor.
 *
 * Drives the supervisor over a FAKE fork (mock OS layer) + a MANUAL scheduler:
 *   - fork → child `ready` beacon → parent hands the charter → status running
 *   - child `finding` IPC message → forwarded to the finding sink
 *   - UNEXPECTED child exit (crash) → exponential-backoff respawn (deterministic)
 *   - respawn bounded by maxRestarts → `crashed-permanently` (no infinite loop)
 *   - clean `stop()` → child killed, NO respawn (exit after stop is expected)
 *   - `stop()` mid-backoff → cancels the pending respawn
 *   - backoffForAttempt is the pure exponential schedule (clamped to cap)
 */

import { describe, expect, test } from "bun:test"
import {
  backoffForAttempt,
  type ChildProcessHandle,
  createSupervisedProcessDaemon,
  type DelayScheduler,
  type ProcessForkPort,
  type SideAgentIpcMessage,
} from "../../src/side-agent"

// ── fake OS layer (mockable fork) ───────────────────────────────────────────

interface FakeChild extends ChildProcessHandle {
  /** Drive a child → parent message. */
  emitMessage(msg: SideAgentIpcMessage): void
  /** Drive the child's exit. */
  emitExit(info?: { code: number | null; signal: string | null }): void
  /** Messages the parent SENT to the child (charter/shutdown). */
  readonly inbox: SideAgentIpcMessage[]
  killed: boolean
}

const mkFakeChild = (pid: number): FakeChild => {
  const msgHandlers = new Set<(m: SideAgentIpcMessage) => void>()
  const exitHandlers = new Set<(i: { code: number | null; signal: string | null }) => void>()
  const inbox: SideAgentIpcMessage[] = []
  let exited = false
  return {
    pid,
    inbox,
    killed: false,
    send(msg) {
      if (exited) return // no-op on dead child
      inbox.push(msg)
    },
    onMessage(h) {
      msgHandlers.add(h)
      return () => msgHandlers.delete(h)
    },
    onExit(h) {
      exitHandlers.add(h)
      return () => exitHandlers.delete(h)
    },
    kill() {
      this.killed = true
    },
    emitMessage(msg) {
      for (const h of msgHandlers) h(msg)
    },
    emitExit(info = { code: 1, signal: null }) {
      if (exited) return
      exited = true
      for (const h of exitHandlers) h(info)
    },
  }
}

/** A fork port that records each forked child so the test can drive it. */
const mkFakeFork = (): { port: ProcessForkPort; children: FakeChild[] } => {
  const children: FakeChild[] = []
  return {
    children,
    port: {
      fork() {
        const c = mkFakeChild(1000 + children.length)
        children.push(c)
        return c
      },
    },
  }
}

/** A manual one-shot scheduler: `schedule` records; `fireAll` runs every pending
 *  callback (in order); `cancel` removes one. */
const mkScheduler = () => {
  let next = 0
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const port: DelayScheduler = {
    schedule(fn, ms) {
      const id = ++next
      pending.set(id, { fn, ms })
      return id
    },
    cancel(handle) {
      pending.delete(handle as number)
    },
  }
  return {
    port,
    pendingCount: () => pending.size,
    lastDelay: () => [...pending.values()].at(-1)?.ms,
    fireAll: () => {
      const fns = [...pending.values()].map((p) => p.fn)
      pending.clear()
      for (const fn of fns) fn()
    },
  }
}

const mkDaemon = (
  fork: ProcessForkPort,
  scheduler: DelayScheduler,
  findings: { summary: string; detail?: string }[],
  overrides: Partial<Parameters<typeof createSupervisedProcessDaemon>[0]> = {},
) =>
  createSupervisedProcessDaemon({
    task: "monitor the test suite",
    maxTurnsPerWake: 3,
    fork,
    forkSpec: { modulePath: "/worker.js" },
    now: () => 0,
    scheduler,
    onFinding: (f) => void findings.push(f),
    baseBackoffMs: 100,
    backoffCapMs: 1000,
    maxRestarts: 3,
    ...overrides,
  })

describe("§4.3 backoffForAttempt — pure exponential schedule", () => {
  test("exponential growth clamped to cap", () => {
    expect(backoffForAttempt(1, 100, 1000)).toBe(100)
    expect(backoffForAttempt(2, 100, 1000)).toBe(200)
    expect(backoffForAttempt(3, 100, 1000)).toBe(400)
    expect(backoffForAttempt(4, 100, 1000)).toBe(800)
    expect(backoffForAttempt(5, 100, 1000)).toBe(1000) // capped
    expect(backoffForAttempt(50, 100, 1000)).toBe(1000) // never Infinity
  })
})

describe("§4.3 supervised process daemon — happy path + IPC", () => {
  test("start ⇒ fork; child ready ⇒ charter handed; status running", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    d.start()
    expect(fork.children.length).toBe(1)
    expect(d.status()).toBe("starting")
    expect(d.pid()).toBe(1000)

    fork.children[0]?.emitMessage({ kind: "ready" })
    expect(d.status()).toBe("running")
    // The charter was handed to the child over IPC.
    const charter = fork.children[0]?.inbox.find((m) => m.kind === "charter")
    expect(charter).toEqual({ kind: "charter", task: "monitor the test suite", maxTurnsPerWake: 3 })
  })

  test("child finding message ⇒ forwarded to the sink (summary + detail)", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const findings: { summary: string; detail?: string }[] = []
    const d = mkDaemon(fork.port, sched.port, findings)
    d.start()
    fork.children[0]?.emitMessage({ kind: "ready" })
    fork.children[0]?.emitMessage({ kind: "finding", summary: "lint failing", detail: "3 errors" })
    fork.children[0]?.emitMessage({ kind: "finding", summary: "ok" })
    expect(findings).toEqual([{ summary: "lint failing", detail: "3 errors" }, { summary: "ok" }])
  })
})

describe("§4.3 supervised process daemon — crash respawn (bounded)", () => {
  test("unexpected exit ⇒ backing-off ⇒ respawn on timer fire", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    d.start()
    fork.children[0]?.emitMessage({ kind: "ready" })
    expect(d.status()).toBe("running")

    fork.children[0]?.emitExit() // crash
    expect(d.status()).toBe("backing-off")
    expect(d.restarts()).toBe(1)
    expect(sched.lastDelay()).toBe(100) // base backoff

    sched.fireAll() // respawn fires
    expect(fork.children.length).toBe(2) // a NEW child forked
    expect(d.status()).toBe("starting")
  })

  test("backoff grows exponentially across successive crashes", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    d.start()
    fork.children[0]?.emitExit()
    expect(sched.lastDelay()).toBe(100)
    sched.fireAll()
    fork.children[1]?.emitExit()
    expect(sched.lastDelay()).toBe(200)
    sched.fireAll()
    fork.children[2]?.emitExit()
    expect(sched.lastDelay()).toBe(400)
    expect(d.restarts()).toBe(3)
  })

  test("past maxRestarts ⇒ crashed-permanently, NO further respawn", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [], { maxRestarts: 2 })
    d.start()
    fork.children[0]?.emitExit() // restart 1
    sched.fireAll()
    fork.children[1]?.emitExit() // restart 2
    sched.fireAll()
    fork.children[2]?.emitExit() // would be restart 3 > max
    expect(d.status()).toBe("crashed-permanently")
    expect(sched.pendingCount()).toBe(0) // no pending respawn
    const before = fork.children.length
    sched.fireAll()
    expect(fork.children.length).toBe(before) // no new fork
  })
})

describe("§4.3 supervised process daemon — clean stop", () => {
  test("stop ⇒ child killed + shutdown sent; exit after stop does NOT respawn", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    d.start()
    fork.children[0]?.emitMessage({ kind: "ready" })
    d.stop()
    expect(fork.children[0]?.killed).toBe(true)
    expect(fork.children[0]?.inbox.some((m) => m.kind === "shutdown")).toBe(true)
    expect(d.status()).toBe("stopped")

    // A subsequent exit (the child observing the kill) must NOT trigger respawn.
    fork.children[0]?.emitExit({ code: 0, signal: "SIGTERM" })
    expect(d.status()).toBe("stopped")
    expect(sched.pendingCount()).toBe(0)
    expect(fork.children.length).toBe(1)
  })

  test("stop mid-backoff ⇒ cancels the pending respawn (no zombie fork)", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    d.start()
    fork.children[0]?.emitExit() // crash ⇒ backoff scheduled
    expect(d.status()).toBe("backing-off")
    expect(sched.pendingCount()).toBe(1)
    d.stop()
    expect(sched.pendingCount()).toBe(0) // respawn cancelled
    sched.fireAll() // even if something lingered, no respawn
    expect(fork.children.length).toBe(1)
    expect(d.status()).toBe("stopped")
  })

  test("NO-THROW: stop before start, double stop, double start", () => {
    const fork = mkFakeFork()
    const sched = mkScheduler()
    const d = mkDaemon(fork.port, sched.port, [])
    expect(() => d.stop()).not.toThrow()
    d.start()
    expect(() => d.start()).not.toThrow() // idempotent
    expect(fork.children.length).toBe(1) // second start is a no-op
    expect(() => {
      d.stop()
      d.stop()
    }).not.toThrow()
  })
})
