/**
 * §4.3 HELLGATE — the PROCESS-backed side-agent daemon registry adapter.
 *
 * `createProcessSideAgentDaemonRegistry` satisfies the same `SideAgentDaemonPort`
 * shape the in-process `createSideAgentDaemonRegistry` does, but backs EACH daemon
 * with a `createSupervisedProcessDaemon` over an injected `ProcessForkPort`. This
 * suite drives the adapter over a FAKE fork (no real OS fork) + a manual scheduler
 * and asserts the cross-process semantics surface through the registry:
 *
 *   - spawn ⇒ the supervisor is STARTED (a child is forked via the injected port)
 *   - a child `finding` IPC message surfaces through `findings()`, tagged with the
 *     daemon id + an incrementing wake counter (mirrors the in-process finding)
 *   - `list()` maps the supervisor status → the SideAgentStatus vocab + reflects
 *     wakes + spec + startedAt/stoppedAt
 *   - `stop(id)` stops the supervisor, is idempotent, returns the right boolean
 *   - `findings({since})` filters by timestamp
 *   - the `maxConcurrent` cap throws the SAME `SideAgentError("cap-exceeded")`
 *     shape the in-process registry throws
 *
 * TEETH (red-on-injection): a regression that forgets to START the supervisor,
 * drops findings, mis-maps status, or skips the cap MUST fail here.
 */

import { describe, expect, test } from "bun:test"
import type {
  ChildProcessHandle,
  DelayScheduler,
  ProcessForkPort,
  SideAgentIpcMessage,
} from "../../src/side-agent"
import { SideAgentError, type SideAgentSpec } from "../../src/side-agent"
import { createProcessSideAgentDaemonRegistry } from "../../src/side-agent/process-registry"

// ── fake OS layer (mockable fork) — mirrors the supervisor hellgate's fake ────

interface FakeChild extends ChildProcessHandle {
  emitMessage(msg: SideAgentIpcMessage): void
  emitExit(info?: { code: number | null; signal: string | null }): void
  readonly inbox: SideAgentIpcMessage[]
  killed: boolean
  started: boolean
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
    started: true,
    send(msg) {
      if (exited) return
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

const mkFakeFork = (): { port: ProcessForkPort; children: FakeChild[] } => {
  const children: FakeChild[] = []
  return {
    children,
    port: {
      fork() {
        const c = mkFakeChild(2000 + children.length)
        children.push(c)
        return c
      },
    },
  }
}

const mkScheduler = (): DelayScheduler => ({
  schedule: () => 0,
  cancel: () => undefined,
})

const intervalSpec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "monitor the build",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 5,
  maxTurnsPerWake: 2,
  ...over,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

const mkRegistry = (
  fork: ProcessForkPort,
  over: Partial<Parameters<typeof createProcessSideAgentDaemonRegistry>[0]> = {},
) => {
  let clock = 0
  return createProcessSideAgentDaemonRegistry({
    fork,
    scheduler: mkScheduler(),
    now: () => ++clock,
    workerModulePath: "/abs/worker-entry.mjs",
    setInterval: () => 0,
    clearInterval: () => undefined,
    ...over,
  })
}

describe("§4.3 process-backed registry — spawn STARTS a supervised child", () => {
  test("spawn ⇒ a child is forked via the injected port + charter handed on ready", async () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    const id = reg.spawn(intervalSpec())
    expect(typeof id).toBe("string")
    // RED-ON-INJECTION: if the adapter forgets to START the supervisor, no child
    // is ever forked.
    expect(fork.children.length).toBe(1)
    // Child beacons ready ⇒ the supervisor hands the charter (proves the worker
    // module path + task crossed the boundary).
    fork.children[0]?.emitMessage({ kind: "ready" })
    await flush()
    const charter = fork.children[0]?.inbox.find((m) => m.kind === "charter")
    expect(charter).toEqual({
      kind: "charter",
      version: 1,
      wakeId: 1,
      task: "monitor the build",
      maxTurnsPerWake: 2,
    })
  })

  test("the forked spec carries the configured worker module path", () => {
    const forked: string[] = []
    const port: ProcessForkPort = {
      fork(spec) {
        forked.push(spec.modulePath)
        return mkFakeChild(9000)
      },
    }
    const reg = mkRegistry(port, { workerModulePath: "/abs/my-worker.mjs" })
    reg.spawn(intervalSpec())
    expect(forked).toEqual(["/abs/my-worker.mjs"])
  })
})

describe("§4.3 process-backed registry — findings surface across IPC", () => {
  test("a child finding ⇒ findings() returns it tagged with daemon id + wake", async () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    const id = reg.spawn(intervalSpec())
    fork.children[0]?.emitMessage({ kind: "ready" })
    await flush()
    fork.children[0]?.emitMessage({
      kind: "finding",
      summary: "lint failing",
      detail: "3 errors",
      version: 1,
      wakeId: 1,
    })
    fork.children[0]?.emitMessage({ kind: "finding", summary: "ok now", version: 1, wakeId: 1 })
    fork.children[0]?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    await flush()

    const found = reg.findings()
    expect(found.length).toBe(2)
    expect(found[0]?.daemonId).toBe(id)
    expect(found[0]?.summary).toBe("lint failing")
    expect(found[0]?.detail).toBe("3 errors")
    expect(found[0]?.wake).toBe(1)
    // One completed wake — both findings share wake 1. Counting findings as
    // wakes is the H-SA-02 bug this pins.
    expect(found[1]?.summary).toBe("ok now")
    expect(found[1]?.wake).toBe(1)
    expect(found[1]?.detail).toBeUndefined()
    expect(reg.list()[0]?.wakesDone).toBe(1)
  })

  test("findings({since}) filters by timestamp", async () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    reg.spawn(intervalSpec())
    fork.children[0]?.emitMessage({ kind: "ready" })
    await flush()
    fork.children[0]?.emitMessage({ kind: "finding", summary: "first", version: 1, wakeId: 1 })
    fork.children[0]?.emitMessage({ kind: "finding", summary: "second", version: 1, wakeId: 1 })
    fork.children[0]?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    await flush()
    const all = reg.findings()
    const afterFirst = all[0]?.at ?? 0

    const since = reg.findings({ since: afterFirst })
    expect(since.map((f) => f.summary)).toEqual(["second"])
  })

  test("findings are tagged by their OWN daemon when several run", async () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port, { maxConcurrent: 3 })
    const a = reg.spawn(intervalSpec({ task: "A" }))
    const b = reg.spawn(intervalSpec({ task: "B" }))
    fork.children[0]?.emitMessage({ kind: "ready" })
    fork.children[1]?.emitMessage({ kind: "ready" })
    await flush()
    fork.children[0]?.emitMessage({ kind: "finding", summary: "from-A", version: 1, wakeId: 1 })
    fork.children[0]?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    fork.children[1]?.emitMessage({ kind: "finding", summary: "from-B", version: 1, wakeId: 1 })
    fork.children[1]?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    await flush()

    const byDaemon = new Map(reg.findings().map((f) => [f.summary, f.daemonId]))
    expect(byDaemon.get("from-A")).toBe(a)
    expect(byDaemon.get("from-B")).toBe(b)
  })
})

describe("§4.3 process-backed registry — list() reflects status", () => {
  test("a running daemon lists as running with its spec + wake progress", async () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    const id = reg.spawn(intervalSpec())
    fork.children[0]?.emitMessage({ kind: "ready" })
    await flush()
    fork.children[0]?.emitMessage({ kind: "finding", summary: "w1", version: 1, wakeId: 1 })
    fork.children[0]?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    await flush()

    const list = reg.list()
    expect(list.length).toBe(1)
    const snap = list[0]
    expect(snap?.id).toBe(id)
    expect(snap?.status).toBe("running")
    expect(snap?.spec.task).toBe("monitor the build")
    expect(snap?.wakesDone).toBe(1)
    expect(typeof snap?.startedAt).toBe("number")
    expect(snap?.stoppedAt).toBeUndefined()
  })

  test("a permanently-crashed daemon maps to the failed status", () => {
    const fork = mkFakeFork()
    // maxRestarts:0 ⇒ first crash is terminal (crashed-permanently).
    const reg = mkRegistry(fork.port, { maxRestarts: 0 })
    reg.spawn(intervalSpec())
    fork.children[0]?.emitMessage({ kind: "ready" })
    fork.children[0]?.emitExit() // unexpected crash, no restarts allowed
    const snap = reg.list()[0]
    // RED-ON-INJECTION: a crashed-permanently supervisor must NOT report running.
    expect(snap?.status).toBe("failed")
  })
})

describe("§4.3 process-backed registry — stop() is idempotent", () => {
  test("stop ⇒ supervisor stopped, child killed, status stopped; second stop ⇒ true; unknown ⇒ false", () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    const id = reg.spawn(intervalSpec())
    fork.children[0]?.emitMessage({ kind: "ready" })

    expect(reg.stop(id)).toBe(true)
    expect(fork.children[0]?.killed).toBe(true)
    expect(reg.list()[0]?.status).toBe("stopped")
    expect(reg.list()[0]?.stoppedAt).toBeDefined()
    // idempotent — an existing id stops cleanly twice.
    expect(reg.stop(id)).toBe(true)
    // unknown id ⇒ false (mirrors the in-process registry).
    expect(reg.stop("sa-does-not-exist")).toBe(false)
  })
})

describe("§4.3 process-backed registry — concurrency cap", () => {
  test("spawning past maxConcurrent throws the SAME cap-exceeded error shape", () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port, { maxConcurrent: 1 })
    reg.spawn(intervalSpec())
    let caught: unknown
    try {
      reg.spawn(intervalSpec())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SideAgentError)
    expect((caught as SideAgentError).code).toBe("cap-exceeded")
    expect((caught as SideAgentError).message).toContain("cap reached")
  })

  test("a STOPPED daemon frees its concurrency slot (cap counts running only)", () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port, { maxConcurrent: 1 })
    const first = reg.spawn(intervalSpec())
    reg.stop(first)
    // RED-ON-INJECTION: if the cap counted terminal daemons, this would throw.
    expect(() => reg.spawn(intervalSpec())).not.toThrow()
  })
})

describe("§4.3 process-backed registry — NO-THROW surface", () => {
  test("list/findings/stop never throw on an empty registry", () => {
    const fork = mkFakeFork()
    const reg = mkRegistry(fork.port)
    expect(() => reg.list()).not.toThrow()
    expect(reg.list()).toEqual([])
    expect(() => reg.findings()).not.toThrow()
    expect(reg.findings()).toEqual([])
    expect(reg.stop("nope")).toBe(false)
  })
})
