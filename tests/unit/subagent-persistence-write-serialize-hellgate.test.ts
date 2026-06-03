/**
 * Hydrating-wrapper PER-HANDLE WRITE SERIALIZATION — hellgate (ADR-0158 Phase 1).
 *
 * Seals the happens-before edge between the fork-time "running" snapshot save
 * and the completion/cancel TERMINAL snapshot save inside
 * `persistentBackgroundSubagentScheduler`.
 *
 * THE BUG (pre-fix): both saves were independently-scheduled fire-and-forget
 * `store.save(...)` promises with NO ordering. With an append-only /
 * last-line-wins store and a runner that settles synchronously (cached /
 * sync-resolved, or a cancel that flips the inner to terminal in-line), the
 * TERMINAL save could land BEFORE the running save — persisting a FINISHED
 * handle as `status:"running"`, i.e. a zombie that re-hydrates as still-running
 * on the next process.
 *
 * THE FIX: per-id `lastWrite` promise chain — the running save is durably
 * ordered before the terminal save, and a rejected link does not wedge the
 * chain.
 *
 * ANTI-THEATER: the store below makes the FIRST save resolve STRICTLY AFTER the
 * SECOND (`save` delay decreases per call). Against the unfixed code that
 * inverts the on-disk order (running lands last → zombie); the fix forces the
 * running save to complete before the terminal save is even issued, so the
 * last-line-wins state is always TERMINAL.
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

/** Drain enough microtasks to let every chained write settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

/** A store whose `save` records the LAST-LINE-WINS view (latest line per id)
 *  AND the exact completion order. Crucially, each `save` resolves after a
 *  DECREASING number of microtask ticks: the 1st save waits longest, the 2nd
 *  less, etc. This deterministically inverts completion order vs. issue order
 *  for any code that issues both saves without a happens-before edge. */
const orderInvertingStore = (): {
  store: PersistentSchedulerStore
  completionOrder: Array<{ id: string; status: string }>
  latestById: Map<string, PersistedHandle>
} => {
  const completionOrder: Array<{ id: string; status: string }> = []
  const latestById = new Map<string, PersistedHandle>()
  let issued = 0
  // First call gets the largest delay so it completes LAST under naive racing.
  const MAX_TICKS = 30
  const store: PersistentSchedulerStore = {
    async save(h) {
      const myIndex = issued
      issued += 1
      const ticks = Math.max(0, MAX_TICKS - myIndex * MAX_TICKS)
      for (let i = 0; i < ticks; i += 1) await Promise.resolve()
      // last-line-wins: the latest line for an id is the current persisted state
      latestById.set(h.id, h)
      completionOrder.push({ id: h.id, status: h.status })
    },
    async load(id) {
      return latestById.get(id) ?? null
    },
    async list(workspace) {
      return Array.from(latestById.values())
        .filter((h) => h.workspace === workspace)
        .sort((a, b) => b.startedAt - a.startedAt)
    },
    async delete(id) {
      latestById.delete(id)
    },
    async prune() {
      return 0
    },
  }
  return { store, completionOrder, latestById }
}

/** A runner that resolves SYNCHRONOUSLY (already-settled promise). This makes
 *  `inner.await(id)` resolve on the very next microtask after fork(), tightly
 *  racing the fork-time running save. */
const syncRunner: SubagentRunner = (): Promise<SliceResult> =>
  Promise.resolve({ ok: true, finalText: "instant", turns: 1 })

const mkInner = (runner: SubagentRunner = syncRunner): BackgroundSubagentScheduler =>
  defaultBackgroundSubagentScheduler({ runner })

describe("Hydrating wrapper — per-handle write serialization", () => {
  test("HG-SER-1: sync-settling runner → final persisted line is TERMINAL, not 'running'", async () => {
    const f = orderInvertingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(syncRunner),
      store: f.store,
      workspace: "/ws/SER",
    })

    const id = sched.fork({ task: "instant-work" })
    await flush()

    // The current persisted state (last-line-wins) MUST be the terminal one.
    const latest = f.latestById.get(id)
    expect(latest).toBeDefined()
    expect(latest?.status).toBe("completed")

    // Ordering is deterministic: the "running" line is durably written BEFORE
    // the terminal one — never inverted into a zombie.
    const forThisId = f.completionOrder.filter((e) => e.id === id)
    expect(forThisId.length).toBeGreaterThanOrEqual(2)
    expect(forThisId[0]?.status).toBe("running")
    expect(forThisId.at(-1)?.status).toBe("completed")
  })

  test("HG-SER-2: cancel that flips inner terminal in-line → terminal wins, ordered after running", async () => {
    // A runner that never settles on its own: the only terminal transition is
    // the cancel, which the inner flips synchronously.
    const neverRunner: SubagentRunner = () => new Promise<SliceResult>(() => {})
    const f = orderInvertingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(neverRunner),
      store: f.store,
      workspace: "/ws/SER",
    })

    const id = sched.fork({ task: "cancel-race" })
    // Cancel synchronously right after fork — before the running save settles.
    const ok = sched.cancel(id)
    expect(ok).toBe(true)
    await flush()

    const latest = f.latestById.get(id)
    expect(latest?.status).toBe("cancelled")

    const forThisId = f.completionOrder.filter((e) => e.id === id)
    expect(forThisId.at(-1)?.status).toBe("cancelled")
    // The running snapshot must have been persisted strictly before cancel.
    const firstRunningIdx = forThisId.findIndex((e) => e.status === "running")
    const cancelIdx = forThisId.findIndex((e) => e.status === "cancelled")
    expect(firstRunningIdx).toBeGreaterThanOrEqual(0)
    expect(cancelIdx).toBeGreaterThan(firstRunningIdx)
  })

  test("HG-SER-3: a rejected save link does NOT wedge later writes on the same id", async () => {
    // Store whose FIRST save rejects; subsequent saves succeed. The chain must
    // not be wedged — the terminal save must still persist.
    let calls = 0
    const latestById = new Map<string, PersistedHandle>()
    const store: PersistentSchedulerStore = {
      async save(h) {
        calls += 1
        if (calls === 1) throw new Error("io-failed: first write blows up")
        latestById.set(h.id, h)
      },
      async load(id) {
        return latestById.get(id) ?? null
      },
      async list() {
        return []
      },
      async delete() {},
      async prune() {
        return 0
      },
    }
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(syncRunner),
      store,
      workspace: "/ws/SER",
    })
    const id = sched.fork({ task: "wedge-test" })
    await flush()
    // First (running) save threw; the terminal save still ran and persisted.
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(latestById.get(id)?.status).toBe("completed")
  })
})
