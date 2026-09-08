/**
 * R05 / H-SA-02 + H-SA-01 — same parent-owned control contract on BOTH backers.
 *
 * Fake clock only. Process path uses a fake fork (OS-child protocol is the
 * integration rail). Counting findings as wakes must fail.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ChildProcessHandle,
  createProcessSideAgentDaemonRegistry,
  createSideAgentDaemonRegistry,
  type DelayScheduler,
  type ProcessForkPort,
  type SideAgentDaemonOpts,
  type SideAgentDaemonRegistry,
  SideAgentError,
  type SideAgentIpcMessage,
  type SideAgentRunnerPort,
  type SideAgentSpec,
} from "@/side-agent"

const flush = () => new Promise((r) => setTimeout(r, 0))

const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "watch the build",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 100,
  maxTurnsPerWake: 3,
  ...over,
})

const mkTimers = () => {
  const handlers = new Map<number, () => void>()
  const cleared = new Set<number>()
  let next = 0
  return {
    setInterval: (h: () => void, _ms: number): unknown => {
      const id = ++next
      handlers.set(id, h)
      return id
    },
    clearInterval: (handle: unknown): void => {
      cleared.add(handle as number)
    },
    fireLatest: (): void => {
      const h = handlers.get(next)
      if (h !== undefined) h()
    },
    isCleared: (handle: unknown): boolean => cleared.has(handle as number),
  }
}

const mkClock = () => {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

interface FakeChild extends ChildProcessHandle {
  emitMessage(msg: SideAgentIpcMessage): void
  emitExit(info?: { code: number | null; signal: string | null }): void
  readonly inbox: SideAgentIpcMessage[]
}

const mkFakeChild = (pid: number): FakeChild => {
  const msgHandlers = new Set<(m: SideAgentIpcMessage) => void>()
  const exitHandlers = new Set<(i: { code: number | null; signal: string | null }) => void>()
  const inbox: SideAgentIpcMessage[] = []
  let exited = false
  return {
    pid,
    inbox,
    send(msg) {
      if (!exited) inbox.push(msg)
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
      exited = true
    },
    emitMessage(msg) {
      for (const h of msgHandlers) h(msg)
    },
    emitExit(info: { code: number | null; signal: string | null } = { code: 1, signal: null }) {
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
        const c = mkFakeChild(3000 + children.length)
        children.push(c)
        return c
      },
    },
  }
}

const stampWakeIpc = (wakeId: number, msg: SideAgentIpcMessage): SideAgentIpcMessage => {
  if (msg.kind === "ready" || msg.kind === "shutdown" || msg.kind === "charter") return msg
  return {
    ...msg,
    version: "version" in msg && msg.version !== undefined ? msg.version : 1,
    wakeId: "wakeId" in msg && typeof msg.wakeId === "number" ? msg.wakeId : wakeId,
  }
}

const mkScheduler = (): DelayScheduler => ({
  schedule: () => 0,
  cancel: () => undefined,
})

const mkRunner = (
  outcomes: Array<
    { summary: string; detail?: string } | readonly { summary: string }[] | null | "throw"
  >,
): SideAgentRunnerPort => ({
  run: async ({ wake }) => {
    const o = outcomes[wake - 1] ?? null
    if (o === "throw") throw new Error("pass blew up")
    return o
  },
})

type Backer = "in-process" | "process"

interface Harness {
  readonly backer: Backer
  readonly reg: SideAgentDaemonRegistry
  readonly timers: ReturnType<typeof mkTimers>
  readonly clock: ReturnType<typeof mkClock>
  readonly child: () => FakeChild | undefined
  fireWake: () => Promise<void>
  completeProcess: (wakeId: number, msgs: SideAgentIpcMessage[]) => Promise<void>
}

const mkInProcess = (
  runner: SideAgentRunnerPort,
  over: Partial<SideAgentDaemonOpts> = {},
): Harness => {
  const timers = mkTimers()
  const clock = mkClock()
  const mailbox = { send: () => undefined }
  const reg = createSideAgentDaemonRegistry({
    runner,
    mailbox,
    mainRecipient: "main",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: clock.now,
    ...over,
  })
  return {
    backer: "in-process",
    reg,
    timers,
    clock,
    child: () => undefined,
    fireWake: async () => {
      timers.fireLatest()
      await flush()
    },
    completeProcess: async () => undefined,
  }
}

const mkProcess = (
  over: Partial<Parameters<typeof createProcessSideAgentDaemonRegistry>[0]> = {},
): Harness => {
  const timers = mkTimers()
  const clock = mkClock()
  const fork = mkFakeFork()
  const reg = createProcessSideAgentDaemonRegistry({
    fork: fork.port,
    scheduler: mkScheduler(),
    now: clock.now,
    workerModulePath: "/abs/worker-entry.mjs",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...over,
  })
  let ready = false
  return {
    backer: "process",
    reg,
    timers,
    clock,
    child: () => fork.children[0],
    fireWake: async () => {
      if (!ready) {
        fork.children[0]?.emitMessage({ kind: "ready" })
        ready = true
        await flush()
        return
      }
      timers.fireLatest()
      await flush()
    },
    completeProcess: async (wakeId, msgs) => {
      for (const m of msgs) fork.children[0]?.emitMessage(stampWakeIpc(wakeId, m))
      const last = msgs.at(-1)
      const needsTerminal =
        last !== undefined &&
        last.kind !== "completed" &&
        last.kind !== "no_finding" &&
        last.kind !== "failed" &&
        last.kind !== "cancelled"
      if (needsTerminal) {
        fork.children[0]?.emitMessage({ kind: "completed", version: 1, wakeId })
      }
      await flush()
    },
  }
}

describe.each(["in-process", "process"] as const)("R05 control contract (%s)", (backer) => {
  const spawnOk = (h: Harness, over: Partial<SideAgentSpec> = {}): string => h.reg.spawn(spec(over))

  test("invalid spec is refused (empty task / everyMs<=0 / maxWakes<1 / event without source)", () => {
    const h = backer === "in-process" ? mkInProcess({ run: async () => null }) : mkProcess()
    expect(() => spawnOk(h, { task: "  " })).toThrow(SideAgentError)
    expect(() => spawnOk(h, { trigger: { kind: "interval", everyMs: 0 } })).toThrow(SideAgentError)
    expect(() => spawnOk(h, { maxWakes: 0 })).toThrow(SideAgentError)
    expect(() => spawnOk(h, { trigger: { kind: "event", topic: "x" } })).toThrow(SideAgentError)
    expect(h.reg.list()).toEqual([])
  })

  test("repeated interval wake increments wakesDone once per wake", async () => {
    const h =
      backer === "in-process"
        ? mkInProcess(mkRunner([{ summary: "a" }, { summary: "b" }]))
        : mkProcess()
    spawnOk(h, { maxWakes: 10 })
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(1, [{ kind: "finding", summary: "a" }])
    }
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(2, [{ kind: "finding", summary: "b" }])
    }
    expect(h.reg.list()[0]?.wakesDone).toBe(2)
    expect(h.reg.findings().map((f) => f.wake)).toEqual([1, 2])
  })

  test("maxWakes is a hard ceiling — auto-stop, no extra pass", async () => {
    const h =
      backer === "in-process"
        ? mkInProcess(mkRunner([{ summary: "1" }, { summary: "2" }, { summary: "nope" }]))
        : mkProcess()
    spawnOk(h, { maxWakes: 2 })
    await h.fireWake()
    if (backer === "process") await h.completeProcess(1, [{ kind: "finding", summary: "1" }])
    await h.fireWake()
    if (backer === "process") await h.completeProcess(2, [{ kind: "finding", summary: "2" }])
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(3, [{ kind: "finding", summary: "nope" }])
    }
    expect(h.reg.list()[0]?.wakesDone).toBe(2)
    expect(h.reg.list()[0]?.status).toBe("stopped")
    expect(h.timers.isCleared(1)).toBe(true)
  })

  test("idleReapMs with no finding → idle-reaped", async () => {
    const h = backer === "in-process" ? mkInProcess({ run: async () => null }) : mkProcess()
    spawnOk(h, { idleReapMs: 5000 })
    h.clock.advance(6000)
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(1, [{ kind: "no_finding", version: 1, wakeId: 1 }])
    }
    expect(h.reg.list()[0]?.status).toBe("idle-reaped")
    expect(h.reg.findings()).toEqual([])
  })

  test("multiple findings in one wake share one wakesDone", async () => {
    const h =
      backer === "in-process"
        ? mkInProcess(mkRunner([[{ summary: "a" }, { summary: "b" }]]))
        : mkProcess()
    spawnOk(h)
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(1, [
        { kind: "finding", summary: "a" },
        { kind: "finding", summary: "b" },
      ])
    }
    expect(h.reg.findings().map((f) => f.summary)).toEqual(["a", "b"])
    expect(h.reg.findings().map((f) => f.wake)).toEqual([1, 1])
    expect(h.reg.list()[0]?.wakesDone).toBe(1)
  })

  test("null / no_finding → feed empty, daemon not failed", async () => {
    const h = backer === "in-process" ? mkInProcess({ run: async () => null }) : mkProcess()
    spawnOk(h, { maxWakes: 5 })
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(1, [{ kind: "no_finding", version: 1, wakeId: 1 }])
    }
    expect(h.reg.findings()).toEqual([])
    expect(h.reg.list()[0]?.status).toBe("running")
    expect(h.reg.list()[0]?.wakesDone).toBe(1)
  })

  test("throw / failed → status failed, feed empty", async () => {
    const h =
      backer === "in-process"
        ? mkInProcess({
            run: async () => {
              throw new Error("boom")
            },
          })
        : mkProcess()
    spawnOk(h)
    await h.fireWake()
    if (backer === "process") {
      await h.completeProcess(1, [{ kind: "failed", version: 1, wakeId: 1, reason: "boom" }])
    }
    expect(h.reg.findings()).toEqual([])
    expect(h.reg.list()[0]?.status).toBe("failed")
  })

  test("stop clears the interval timer", () => {
    const h = backer === "in-process" ? mkInProcess({ run: async () => null }) : mkProcess()
    const id = spawnOk(h)
    expect(h.reg.stop(id)).toBe(true)
    expect(h.timers.isCleared(1)).toBe(true)
    expect(h.reg.list()[0]?.status).toBe("stopped")
  })
})

describe("R05 process-only wake protocol", () => {
  test("stale / duplicate terminal is ignored", async () => {
    const h = mkProcess()
    h.reg.spawn(spec({ maxWakes: 5 }))
    await h.fireWake()
    await h.completeProcess(1, [{ kind: "no_finding", version: 1, wakeId: 1 }])
    const wakes = h.reg.list()[0]?.wakesDone
    h.child()?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    h.child()?.emitMessage({ kind: "finding", summary: "ghost", version: 1, wakeId: 1 })
    await flush()
    expect(h.reg.list()[0]?.wakesDone).toBe(wakes)
    expect(h.reg.findings()).toEqual([])
  })

  test("overlapping interval while in-flight coalesces to one pending wake", async () => {
    const h = mkProcess()
    h.reg.spawn(spec({ maxWakes: 10 }))
    await h.fireWake()
    h.timers.fireLatest()
    h.timers.fireLatest()
    await flush()
    expect(h.reg.list()[0]?.wakesDone).toBe(0)
    await h.completeProcess(1, [{ kind: "no_finding", version: 1, wakeId: 1 }])
    await flush()
    expect(h.reg.list()[0]?.wakesDone).toBe(1)
    await h.completeProcess(2, [{ kind: "no_finding", version: 1, wakeId: 2 }])
    await flush()
    expect(h.reg.list()[0]?.wakesDone).toBe(2)
  })

  test("child death after findings is cancelled — wakesDone unchanged, feed kept", async () => {
    const h = mkProcess({ maxRestarts: 0 })
    h.reg.spawn(spec({ maxWakes: 1 }))
    await h.fireWake()
    h.child()?.emitMessage({ kind: "finding", summary: "kept", version: 1, wakeId: 1 })
    h.child()?.emitExit({ code: 1, signal: "SIGKILL" })
    await flush()
    expect(h.reg.findings().map((f) => f.summary)).toEqual(["kept"])
    expect(h.reg.list()[0]?.wakesDone).toBe(0)
  })

  test("unversioned / missing wakeId frames are ignored", async () => {
    const h = mkProcess()
    h.reg.spawn(spec())
    await h.fireWake()
    h.child()?.emitMessage({ kind: "finding", summary: "no-version" })
    h.child()?.emitMessage({ kind: "finding", summary: "no-wake", version: 1 })
    h.child()?.emitMessage({ kind: "completed", version: 1, wakeId: 1 })
    await flush()
    expect(h.reg.findings()).toEqual([])
    expect(h.reg.list()[0]?.wakesDone).toBe(1)
  })
})

describe("R05 mutation — counting findings as wakes must fail", () => {
  test("behavioral: two findings one wake ⇒ wakesDone === 1", async () => {
    const h = mkProcess()
    h.reg.spawn(spec())
    await h.fireWake()
    await h.completeProcess(1, [
      { kind: "finding", summary: "a" },
      { kind: "finding", summary: "b" },
    ])
    expect(h.reg.list()[0]?.wakesDone).toBe(1)
    expect(h.reg.findings()).toHaveLength(2)
  })

  test("source: process-registry must not increment wakes per finding", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../../src/side-agent/process-registry.ts"),
      "utf8",
    )
    expect(src).not.toMatch(/state\.wakes\s*\+=\s*1/)
    expect(src).not.toMatch(/wakes:\s*0/)
    expect(src.includes("createDaemonEngine")).toBe(true)
  })

  test("source: worker-entry must not synthesize a finding on null/failure", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../../src/side-agent/worker-entry.mjs"),
      "utf8",
    )
    expect(src).not.toContain("pass returned no finding")
    expect(src).toContain('emitTerminal("no_finding"')
    expect(src).toContain('emitTerminal("failed"')
  })
})
