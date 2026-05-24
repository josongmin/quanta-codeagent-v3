/**
 * Hydrating-wrapper hellgate — ADR-0158 Phase 1.
 *
 * Seals `persistentBackgroundSubagentScheduler` wrapping semantics:
 *
 *   A. Hydration (5)
 *   B. Save-on-event (5)
 *   C. Interrupted status (5)
 *
 * Total = 15 cases. Uses a FAKE store + a controllable in-memory scheduler
 * (`defaultBackgroundSubagentScheduler` with a deferred runner) so the
 * tests stay fast and host-process-agnostic.
 */

import { describe, expect, test } from "bun:test"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import {
  type PersistedHandle,
  type PersistentSchedulerStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"
import type { SubagentResult as SliceResult, SubagentRunner } from "@/subagent"

/* ====================================================================== */
/* fakes                                                                   */
/* ====================================================================== */

const fakeStore = (): {
  store: PersistentSchedulerStore
  saved: PersistedHandle[]
  bypassByWorkspace: Map<string, PersistedHandle[]>
  saveCount: () => number
  pruneCalls: Array<{ workspace: string; maxAgeMs: number }>
} => {
  const byId = new Map<string, PersistedHandle>()
  const saved: PersistedHandle[] = []
  const bypassByWorkspace = new Map<string, PersistedHandle[]>()
  const pruneCalls: Array<{ workspace: string; maxAgeMs: number }> = []
  const store: PersistentSchedulerStore = {
    async save(h) {
      saved.push(h)
      byId.set(h.id, h)
    },
    async load(id) {
      return byId.get(id) ?? null
    },
    async list(workspace) {
      const seeded = bypassByWorkspace.get(workspace) ?? []
      const combined: PersistedHandle[] = [
        ...seeded,
        ...Array.from(byId.values()).filter((h) => h.workspace === workspace),
      ]
      combined.sort((a, b) => b.startedAt - a.startedAt)
      return combined
    },
    async delete(id) {
      byId.delete(id)
    },
    async prune(workspace, maxAgeMs) {
      pruneCalls.push({ workspace, maxAgeMs })
      return 0
    },
  }
  return { store, saved, bypassByWorkspace, saveCount: () => saved.length, pruneCalls }
}

/** A runner whose completion is externally controlled. */
const controlledRunner = (): {
  runner: SubagentRunner
  resolve: (out: SliceResult) => void
  reject: (e: Error) => void
} => {
  let resolveFn: ((out: SliceResult) => void) | null = null
  let rejectFn: ((e: Error) => void) | null = null
  const runner: SubagentRunner = () =>
    new Promise<SliceResult>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
  return {
    runner,
    resolve: (out) => {
      if (resolveFn) resolveFn(out)
    },
    reject: (e) => {
      if (rejectFn) rejectFn(e)
    },
  }
}

const mkInner = (
  runner: SubagentRunner = (): Promise<SliceResult> =>
    Promise.resolve({ ok: true, finalText: "done", turns: 1 }),
): BackgroundSubagentScheduler => defaultBackgroundSubagentScheduler({ runner })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const mkPersisted = (over: Partial<PersistedHandle> & { id: string }): PersistedHandle => ({
  id: over.id,
  spec: over.spec ?? { task: "saved" },
  status: over.status ?? "completed",
  startedAt: over.startedAt ?? 100,
  turns: over.turns ?? 1,
  outputSummary: over.outputSummary ?? "(saved)",
  workspace: over.workspace ?? "/ws/H",
  ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
  ...(over.outputDetail !== undefined ? { outputDetail: over.outputDetail } : {}),
  ...(over.errorMessage !== undefined ? { errorMessage: over.errorMessage } : {}),
  ...(over.hostPid !== undefined ? { hostPid: over.hostPid } : {}),
})

/* ====================================================================== */
/* A. Hydration                                                            */
/* ====================================================================== */

describe("A. Hydration", () => {
  test("HG-17: empty store → wrapper with no handles", async () => {
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/H",
      isProcessAlive: () => true,
    })
    expect(sched.list()).toEqual([])
  })

  test("HG-18: store has 2 terminal handles → exposed via list()", async () => {
    const f = fakeStore()
    f.bypassByWorkspace.set("/ws/H", [
      mkPersisted({ id: "bg-done1", status: "completed", startedAt: 100 }),
      mkPersisted({ id: "bg-fail1", status: "failed", startedAt: 200, errorMessage: "oops" }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/H",
      isProcessAlive: () => true,
    })
    const ids = sched.list().map((e) => e.id)
    expect(ids).toEqual(["bg-fail1", "bg-done1"]) // DESC by startedAt
  })

  test("HG-19: running handle, hostPid ALIVE → stays running (process owns it)", async () => {
    const f = fakeStore()
    f.bypassByWorkspace.set("/ws/H", [
      mkPersisted({
        id: "bg-running-alive",
        status: "running",
        startedAt: 100,
        hostPid: 4242,
      }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/H",
      isProcessAlive: (pid) => pid === 4242,
    })
    const polled = sched.poll("bg-running-alive")
    expect(polled).not.toBeNull()
    expect(polled?.status).toBe("running")
    // No reclassify save should have happened for an alive PID.
    const savedIds = f.saved.map((h) => h.id)
    expect(savedIds.includes("bg-running-alive")).toBe(false)
  })

  test("HG-20: running handle, hostPid DEAD → reclassified as 'interrupted' + store updated", async () => {
    const f = fakeStore()
    f.bypassByWorkspace.set("/ws/H", [
      mkPersisted({
        id: "bg-running-dead",
        status: "running",
        startedAt: 100,
        hostPid: 9999,
      }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/H",
      isProcessAlive: (pid) => pid !== 9999,
      now: () => 5_000,
    })
    const polled = sched.poll("bg-running-dead")
    expect(polled).not.toBeNull()
    expect((polled?.status as unknown as string) ?? "").toBe("interrupted")
    // Reclassify wrote through.
    const updated = f.saved.find((h) => h.id === "bg-running-dead")
    expect(updated).toBeDefined()
    expect(updated?.status).toBe("interrupted")
    expect(updated?.endedAt).toBe(5_000)
  })

  test("HG-21: running handle, NO hostPid → conservatively → 'interrupted'", async () => {
    const f = fakeStore()
    f.bypassByWorkspace.set("/ws/H", [
      mkPersisted({
        id: "bg-no-pid",
        status: "running",
        startedAt: 50,
        // hostPid intentionally absent (the key is omitted)
      }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/H",
      isProcessAlive: () => true, // would say alive — irrelevant when PID missing
    })
    const polled = sched.poll("bg-no-pid")
    expect((polled?.status as unknown as string) ?? "").toBe("interrupted")
  })
})

/* ====================================================================== */
/* B. Save-on-event                                                        */
/* ====================================================================== */

describe("B. Save-on-event", () => {
  test("HG-22: fork() — inner.fork called AND store.save called with the new handle", async () => {
    const ctrl = controlledRunner()
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(ctrl.runner),
      store: f.store,
      workspace: "/ws/B",
    })
    const id = sched.fork({ task: "hello" })
    await flush()
    const saved = f.saved.find((h) => h.id === id)
    expect(saved).toBeDefined()
    expect(saved?.spec.task).toBe("hello")
    expect(saved?.status).toBe("running")
  })

  test("HG-23: cancel() — store.save called with cancelled status", async () => {
    const ctrl = controlledRunner()
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(ctrl.runner),
      store: f.store,
      workspace: "/ws/B",
    })
    const id = sched.fork({ task: "cancel-me" })
    await flush()
    const beforeCount = f.saveCount()
    const ok = sched.cancel(id)
    await flush()
    expect(ok).toBe(true)
    expect(f.saveCount()).toBeGreaterThan(beforeCount)
    const last = f.saved.filter((h) => h.id === id).at(-1)
    expect(last?.status).toBe("cancelled")
  })

  test("HG-24: runner success → store.save with status=completed", async () => {
    const ctrl = controlledRunner()
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(ctrl.runner),
      store: f.store,
      workspace: "/ws/B",
    })
    const id = sched.fork({ task: "complete-me" })
    await flush()
    ctrl.resolve({ ok: true, finalText: "answer", turns: 2 })
    await flush()
    await flush()
    const last = f.saved.filter((h) => h.id === id).at(-1)
    expect(last?.status).toBe("completed")
    expect(last?.turns).toBe(2)
  })

  test("HG-25: runner failure → store.save with errorMessage set", async () => {
    const ctrl = controlledRunner()
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(ctrl.runner),
      store: f.store,
      workspace: "/ws/B",
    })
    const id = sched.fork({ task: "fail-me" })
    await flush()
    ctrl.reject(new Error("kaboom"))
    await flush()
    await flush()
    const last = f.saved.filter((h) => h.id === id).at(-1)
    expect(last?.status).toBe("failed")
    expect(last?.errorMessage).toBe("kaboom")
  })

  test("HG-26: prune — delegates to store.prune with workspace", async () => {
    const f = fakeStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/B",
    })
    sched.prune(1234)
    await flush()
    expect(f.pruneCalls.length).toBeGreaterThan(0)
    expect(f.pruneCalls[0]?.workspace).toBe("/ws/B")
    expect(f.pruneCalls[0]?.maxAgeMs).toBe(1234)
  })
})

/* ====================================================================== */
/* C. Interrupted status                                                   */
/* ====================================================================== */

describe("C. Interrupted status", () => {
  const setupInterrupted = async (): Promise<{
    sched: BackgroundSubagentScheduler
    interruptedId: string
    fakes: ReturnType<typeof fakeStore>
  }> => {
    const f = fakeStore()
    const interruptedId = "bg-int1"
    f.bypassByWorkspace.set("/ws/C", [
      mkPersisted({
        id: interruptedId,
        status: "running",
        startedAt: 50,
        hostPid: 9999, // will be dead
      }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(),
      store: f.store,
      workspace: "/ws/C",
      isProcessAlive: (pid) => pid !== 9999,
    })
    return { sched, interruptedId, fakes: f }
  }

  test("HG-27: poll(interruptedId) returns the interrupted snapshot", async () => {
    const { sched, interruptedId } = await setupInterrupted()
    const got = sched.poll(interruptedId)
    expect(got).not.toBeNull()
    expect((got?.status as unknown as string) ?? "").toBe("interrupted")
  })

  test("HG-28: await(interruptedId) resolves immediately with interrupted snapshot", async () => {
    const { sched, interruptedId } = await setupInterrupted()
    const t0 = Date.now()
    const got = await sched.await(interruptedId)
    const elapsed = Date.now() - t0
    expect(got).not.toBeNull()
    expect((got?.status as unknown as string) ?? "").toBe("interrupted")
    expect(elapsed).toBeLessThan(50) // should be near-instant
  })

  test("HG-29: cancel(interruptedId) returns false (no live handle)", async () => {
    const { sched, interruptedId } = await setupInterrupted()
    expect(sched.cancel(interruptedId)).toBe(false)
  })

  test("HG-30: fork() of a new task while interruptedId exists — fresh id, no interaction", async () => {
    const { sched, interruptedId, fakes } = await setupInterrupted()
    const newId = sched.fork({ task: "new-work" })
    await flush()
    expect(newId).not.toBe(interruptedId)
    expect(newId.startsWith("bg-")).toBe(true)
    // Interrupted snapshot survives.
    const oldPoll = sched.poll(interruptedId)
    expect((oldPoll?.status as unknown as string) ?? "").toBe("interrupted")
    // New fork was saved fresh.
    const newSaved = fakes.saved.find((h) => h.id === newId)
    expect(newSaved).toBeDefined()
  })

  test("HG-31: list() shows interrupted alongside live + terminal, sorted by startedAt DESC", async () => {
    const ctrl = controlledRunner()
    const f = fakeStore()
    f.bypassByWorkspace.set("/ws/C", [
      mkPersisted({ id: "bg-old-done", status: "completed", startedAt: 10 }),
      mkPersisted({
        id: "bg-int1",
        status: "running",
        startedAt: 50,
        hostPid: 9999,
      }),
    ])
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(ctrl.runner),
      store: f.store,
      workspace: "/ws/C",
      isProcessAlive: (pid) => pid !== 9999,
      now: () => 100,
    })
    // Add a live fork with startedAt larger via injected clock (use now via
    // inner; inner takes its own now default Date.now — so just fork after
    // the hydration. Default Date.now() ≫ 50, so the new id sorts first.
    const liveId = sched.fork({ task: "live-now" })
    await flush()
    const list = sched.list()
    const ids = list.map((e) => e.id)
    // Order DESC by startedAt: live (Date.now() — huge), then bg-int1 (50),
    // then bg-old-done (10).
    expect(ids).toEqual([liveId, "bg-int1", "bg-old-done"])
    expect((list[1]?.result.status as unknown as string) ?? "").toBe("interrupted")
    expect(list[2]?.result.status).toBe("completed")
  })
})
