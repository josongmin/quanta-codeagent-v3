/**
 * ALBB-10 — Subagent persistence SAVE OBSERVABILITY (ADR-0158 Phase 1).
 *
 * The hydrating scheduler manufactures a typed `PersistenceError("io-failed")`
 * SPECIFICALLY for a caller to branch on — then discards it at every
 * `store.save` catch site (write-through + save-on-event chain + three
 * `void saveLiveHandle` fire-and-forgets). This left NO way for the host to
 * alert on lost crash/resume snapshots.
 *
 * THE FIX under test: an OPTIONAL injected `onPersistError` sink on
 * `HydratingSchedulerOpts`, invoked at BOTH catch sites, with a `critical`
 * flag distinguishing discoverable-handle loss (fork/terminal/promotion) from
 * routine misses (hydration write-through). NEVER rethrows, NEVER makes
 * `fork()` async. Absent sink ⇒ byte-identical (still swallows).
 *
 * ANTI-THEATER:
 *  - Sink-fires tests inject a store whose `save` REJECTS with a real
 *    `PersistenceError("io-failed")` and observe the sink's `{id, phase,
 *    critical}` — this FAILS today (no sink exists), so it is red-on-injection.
 *  - Mutation check is documented per-path: deleting either catch-site sink
 *    invocation turns the corresponding assertion RED.
 *  - Non-wedge (HG-SER-3) is re-asserted THROUGH the sink'd scheduler.
 *  - Default-OFF re-asserts today's swallow when no sink is injected.
 */

import { describe, expect, test } from "bun:test"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import {
  type HydratingSchedulerOpts,
  type PersistedHandle,
  PersistenceError,
  type PersistentSchedulerStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"
import type { SubagentResult as SliceResult, SubagentRunner } from "@/subagent"

/** Drain enough microtasks to let every chained write settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

/** A runner that resolves SYNCHRONOUSLY (already-settled). Makes
 *  `inner.await(id)` resolve on the next microtask after fork(). */
const syncRunner: SubagentRunner = (): Promise<SliceResult> =>
  Promise.resolve({ ok: true, finalText: "instant", turns: 1 })

/** A runner that never settles on its own — the only terminal transition is a
 *  cancel the inner flips synchronously. */
const neverRunner: SubagentRunner = () => new Promise<SliceResult>(() => {})

const mkInner = (runner: SubagentRunner): BackgroundSubagentScheduler =>
  defaultBackgroundSubagentScheduler({ runner })

/** A store whose `save` ALWAYS throws a typed `PersistenceError("io-failed")`.
 *  Records nothing (every write is lost) — models a full disk / EPERM. */
const alwaysRejectStore = (): { store: PersistentSchedulerStore } => {
  const store: PersistentSchedulerStore = {
    async save(_h) {
      throw new PersistenceError("io-failed", "save blew up (test)")
    },
    async load() {
      return null
    },
    async list() {
      return []
    },
    async delete() {},
    async prune() {
      return 0
    },
  }
  return { store }
}

type SinkEvent = {
  err: PersistenceError
  id: string
  phase: "hydrate-writethrough" | "save-on-event"
  critical: boolean
}

const recordingSink = (): {
  events: SinkEvent[]
  onPersistError: NonNullable<HydratingSchedulerOpts["onPersistError"]>
} => {
  const events: SinkEvent[] = []
  return {
    events,
    onPersistError: (err, ctx) => {
      events.push({ err, id: ctx.id, phase: ctx.phase, critical: ctx.critical })
    },
  }
}

describe("ALBB-10 — persistence save observability", () => {
  test("SINK-1: fork-immediate save failure → sink fires save-on-event, critical:true", async () => {
    const { store } = alwaysRejectStore()
    const sink = recordingSink()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(neverRunner), // no terminal transition — isolate the fork save
      store,
      workspace: "/ws/ALBB10",
      onPersistError: sink.onPersistError,
    })

    const id = sched.fork({ task: "fork-immediate" })
    await flush()

    const forId = sink.events.filter((e) => e.id === id)
    expect(forId.length).toBeGreaterThanOrEqual(1)
    const first = forId[0]
    expect(first?.phase).toBe("save-on-event")
    expect(first?.critical).toBe(true)
    expect(first?.err).toBeInstanceOf(PersistenceError)
    expect(first?.err.code).toBe("io-failed")
  })

  test("SINK-2: cancel-success save failure → sink fires critical:true", async () => {
    const { store } = alwaysRejectStore()
    const sink = recordingSink()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(neverRunner),
      store,
      workspace: "/ws/ALBB10",
      onPersistError: sink.onPersistError,
    })

    const id = sched.fork({ task: "cancel-me" })
    const ok = sched.cancel(id)
    expect(ok).toBe(true)
    await flush()

    // The cancel-triggered terminal save must have surfaced a critical miss.
    const criticalForId = sink.events.filter((e) => e.id === id && e.critical === true)
    expect(criticalForId.length).toBeGreaterThanOrEqual(1)
    expect(criticalForId.every((e) => e.phase === "save-on-event")).toBe(true)
    expect(criticalForId[0]?.err.code).toBe("io-failed")
  })

  test("SINK-3: forceBackground promotion save failure → sink fires critical:true", async () => {
    // Cap the inner at 1 slot with the admission queue on: the first fork runs,
    // the SECOND parks as `queued`; forceBackground(allowBurst) then promotes it
    // (`promoted_now`) — a discoverable-handle transition whose save must fire
    // the critical sink.
    const inner = defaultBackgroundSubagentScheduler({
      runner: neverRunner,
      maxConcurrent: 1,
      admissionQueue: true, // let over-cap fork() park as `queued` (ADR-0487)
    })
    const { store } = alwaysRejectStore()
    const sink = recordingSink()
    const sched = await persistentBackgroundSubagentScheduler({
      inner,
      store,
      workspace: "/ws/ALBB10",
      onPersistError: sink.onPersistError,
    })

    sched.fork({ task: "occupy-slot" }) // takes the single running slot
    const id = sched.fork({ task: "promote-me" }) // parks as queued
    const outcome = sched.forceBackground(id, { allowBurst: true })
    expect(outcome === "promoted_now" || outcome === "moved_to_front").toBe(true)
    await flush()

    const criticalForId = sink.events.filter((e) => e.id === id && e.critical === true)
    expect(criticalForId.length).toBeGreaterThanOrEqual(1)
    expect(criticalForId[0]?.phase).toBe("save-on-event")
    expect(criticalForId[0]?.err.code).toBe("io-failed")
  })

  test("SINK-4: hydration write-through save failure → sink fires hydrate-writethrough, critical:false", async () => {
    // Seed a persisted "running" handle whose hostPid is DEAD so hydration
    // reclassifies it to "interrupted" and write-through-saves — which throws.
    const seeded: PersistedHandle = {
      id: "bg-deadbeefdeadbeef",
      spec: { task: "seeded-running" },
      status: "running",
      startedAt: 1000,
      turns: 0,
      outputSummary: "",
      hostPid: 424242,
      workspace: "/ws/ALBB10",
    }
    const store: PersistentSchedulerStore = {
      async save(_h) {
        throw new PersistenceError("io-failed", "write-through blew up (test)")
      },
      async load() {
        return null
      },
      async list(ws) {
        return ws === "/ws/ALBB10" ? [seeded] : []
      },
      async delete() {},
      async prune() {
        return 0
      },
    }
    const sink = recordingSink()
    await persistentBackgroundSubagentScheduler({
      inner: mkInner(syncRunner),
      store,
      workspace: "/ws/ALBB10",
      isProcessAlive: () => false, // force the dead-pid reclassify path
      onPersistError: sink.onPersistError,
    })
    await flush()

    const forSeed = sink.events.filter((e) => e.id === seeded.id)
    expect(forSeed.length).toBeGreaterThanOrEqual(1)
    expect(forSeed[0]?.phase).toBe("hydrate-writethrough")
    expect(forSeed[0]?.critical).toBe(false)
    expect(forSeed[0]?.err.code).toBe("io-failed")
  })

  test("NON-WEDGE: first save throws → terminal save still persists AND sink saw the failure (HG-SER-3 through the sink'd scheduler)", async () => {
    let calls = 0
    const latestById = new Map<string, PersistedHandle>()
    const store: PersistentSchedulerStore = {
      async save(h) {
        calls += 1
        if (calls === 1) throw new PersistenceError("io-failed", "first write blows up")
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
    const sink = recordingSink()
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(syncRunner),
      store,
      workspace: "/ws/ALBB10",
      onPersistError: sink.onPersistError,
    })
    const id = sched.fork({ task: "wedge-test" })
    await flush()

    // Non-wedge invariant (unchanged): first save threw, terminal still landed.
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(latestById.get(id)?.status).toBe("completed")
    // AND the observability target: the sink saw the first (running) failure.
    expect(sink.events.some((e) => e.id === id)).toBe(true)
    expect(sink.events.find((e) => e.id === id)?.err.code).toBe("io-failed")
  })

  test("DEFAULT-OFF: no sink → first save throws, no throw escapes, terminal still lands (byte-identical swallow)", async () => {
    let calls = 0
    const latestById = new Map<string, PersistedHandle>()
    const store: PersistentSchedulerStore = {
      async save(h) {
        calls += 1
        if (calls === 1) throw new PersistenceError("io-failed", "first write blows up")
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
    // No onPersistError injected — the swallow path must be unchanged.
    const sched = await persistentBackgroundSubagentScheduler({
      inner: mkInner(syncRunner),
      store,
      workspace: "/ws/ALBB10",
    })
    let threw: unknown = null
    let id = ""
    try {
      id = sched.fork({ task: "default-off" })
      await flush()
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull() // no throw escapes fork/hot-path
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(latestById.get(id)?.status).toBe("completed")
  })

  test("SINK-DEFENSIVE: a throwing host sink cannot re-wedge the write chain", async () => {
    // First save throws (surfaced to sink); the sink ITSELF throws. The chain
    // must still run the terminal save — a broken host callback cannot wedge.
    let calls = 0
    const latestById = new Map<string, PersistedHandle>()
    const store: PersistentSchedulerStore = {
      async save(h) {
        calls += 1
        if (calls === 1) throw new PersistenceError("io-failed", "boom")
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
      workspace: "/ws/ALBB10",
      onPersistError: () => {
        throw new Error("host sink is buggy")
      },
    })
    const id = sched.fork({ task: "defensive" })
    await flush()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(latestById.get(id)?.status).toBe("completed")
  })
})
