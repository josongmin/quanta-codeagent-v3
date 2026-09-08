/**
 * R05 / H-SA-01 + H-SA-02 — real OS fork of production `worker-entry.mjs`.
 * Fake-only IPC is not claimed complete here.
 */

import { describe, expect, test } from "bun:test"
import { createProcessSideAgentDaemonRegistry, type SideAgentSpec } from "@/side-agent"
import {
  nodeProcessForkPort,
  sideAgentWorkerModulePath,
} from "../../../../src/host/runtime/side-agent-fork-port"

const waitFor = async (pred: () => boolean, timeoutMs = 8000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return pred()
}

const realScheduler = {
  schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const mkTimers = () => {
  const handlers = new Map<number, () => void>()
  const cleared: unknown[] = []
  let next = 0
  return {
    setInterval: (h: () => void, _ms: number): unknown => {
      const id = ++next
      handlers.set(id, h)
      return id
    },
    clearInterval: (handle: unknown): void => {
      cleared.push(handle)
    },
    cleared,
  }
}

const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "audit the tree",
  trigger: { kind: "interval", everyMs: 60_000 },
  maxWakes: 8,
  maxTurnsPerWake: 2,
  ...over,
})

const mkReg = (env: Record<string, string> = {}, timers?: ReturnType<typeof mkTimers>) =>
  createProcessSideAgentDaemonRegistry({
    fork: nodeProcessForkPort,
    scheduler: realScheduler,
    now: () => Date.now(),
    workerModulePath: sideAgentWorkerModulePath(),
    childEnv: env,
    ...(timers !== undefined
      ? { setInterval: timers.setInterval, clearInterval: timers.clearInterval }
      : {
          setInterval: () => 0,
          clearInterval: () => undefined,
        }),
  })

describe("R05 OS-child worker-entry.mjs protocol", () => {
  test("no_finding terminal → findings feed empty, wakesDone 1, not failed", async () => {
    const reg = mkReg({ QUANTA_SIDE_AGENT_TEST_MODE: "no_finding" })
    const id = reg.spawn(spec())
    const settled = await waitFor(() => (reg.list()[0]?.wakesDone ?? 0) >= 1)
    expect(settled).toBe(true)
    expect(reg.findings()).toEqual([])
    expect(reg.list()[0]?.status).not.toBe("failed")
    expect(reg.stop(id)).toBe(true)
  }, 12_000)

  test("throw/failed terminal → status failed, findings feed empty", async () => {
    const reg = mkReg({ QUANTA_SIDE_AGENT_TEST_MODE: "throw" })
    const id = reg.spawn(spec())
    const settled = await waitFor(() => reg.list()[0]?.status === "failed")
    expect(settled).toBe(true)
    expect(reg.findings()).toEqual([])
    expect(reg.list()[0]?.id).toBe(id)
  }, 12_000)

  test("multi-finding one wake → two feed rows, wakesDone 1", async () => {
    const reg = mkReg({ QUANTA_SIDE_AGENT_TEST_MODE: "multi" })
    const id = reg.spawn(spec())
    const got = await waitFor(() => reg.findings().length >= 2)
    expect(got).toBe(true)
    expect(reg.findings().map((f) => f.summary)).toEqual(["multi-a", "multi-b"])
    expect(reg.findings().every((f) => f.wake === 1)).toBe(true)
    expect(reg.list()[0]?.wakesDone).toBe(1)
    expect(reg.stop(id)).toBe(true)
  }, 12_000)

  test("late terminal after stop is ignored", async () => {
    const reg = mkReg({ QUANTA_SIDE_AGENT_TEST_MODE: "late" })
    const id = reg.spawn(spec())
    await waitFor(() => reg.list()[0]?.status === "running")
    expect(reg.stop(id)).toBe(true)
    await new Promise((r) => setTimeout(r, 600))
    expect(reg.findings()).toEqual([])
    expect(reg.list()[0]?.status).toBe("stopped")
  }, 12_000)

  test("kill/stop returns timer + budget (no further wakes)", async () => {
    const timers = mkTimers()
    const reg = mkReg({}, timers)
    const id = reg.spawn(spec({ maxWakes: 50 }))
    await waitFor(() => reg.list()[0]?.status === "running")
    const wakes = reg.list()[0]?.wakesDone ?? 0
    expect(reg.stop(id)).toBe(true)
    expect(timers.cleared.length).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 80))
    expect(reg.list()[0]?.wakesDone).toBe(wakes)
    expect(reg.list()[0]?.status).toBe("stopped")
    expect(reg.stopAll()).toBe(0)
  }, 12_000)

  test("deterministic production path still posts a real finding (not silence-as-finding)", async () => {
    const reg = mkReg()
    const id = reg.spawn(spec())
    const got = await waitFor(() => reg.findings().length > 0)
    expect(got).toBe(true)
    expect(reg.findings()[0]?.summary).toContain("audit the tree")
    expect(reg.findings()[0]?.detail).toContain("forked child OS process")
    expect(reg.findings()[0]?.detail).not.toContain("pass returned no finding")
    expect(reg.stop(id)).toBe(true)
  }, 12_000)
})
