/**
 * Subagent work-resume hellgate — ADR-0159 Phase 2.
 *
 * Seals the policy + orchestrator surface:
 *
 *   A. defaultResumePolicy        (8)
 *   B. alwaysResumePolicy + askUserResumePolicy (3)
 *   C. resumeInterruptedHandles   (11)
 *
 * Total = 22 cases. Uses a fake `BackgroundSubagentScheduler` + fake
 * `PersistentSchedulerStore` + injected policy so the tests stay decoupled
 * from the in-memory scheduler + jsonl adapter (both already sealed by
 * their own hellgates).
 */

import { describe, expect, test } from "bun:test"
import type {
  BackgroundSubagentScheduler,
  ForceBackgroundOutcome,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
} from "@/agent/subagent-background"
import type { PersistedHandle, PersistentSchedulerStore } from "@/agent/subagent-persistence-store"
import {
  alwaysResumePolicy,
  askUserResumePolicy,
  defaultResumePolicy,
  type ResumeDecision,
  type ResumePolicy,
  resumeInterruptedHandles,
} from "@/agent/subagent-resume"

/* ====================================================================== */
/* fakes                                                                   */
/* ====================================================================== */

const mkHandle = (over: Partial<PersistedHandle> & { id: string }): PersistedHandle => ({
  id: over.id,
  spec: over.spec ?? { task: "saved" },
  status: over.status ?? "interrupted",
  startedAt: over.startedAt ?? 1000,
  turns: over.turns ?? 0,
  outputSummary: over.outputSummary ?? "(interrupted)",
  workspace: over.workspace ?? "/ws/R",
  ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
  ...(over.outputDetail !== undefined ? { outputDetail: over.outputDetail } : {}),
  ...(over.errorMessage !== undefined ? { errorMessage: over.errorMessage } : {}),
  ...(over.hostPid !== undefined ? { hostPid: over.hostPid } : {}),
})

interface FakeScheduler {
  scheduler: BackgroundSubagentScheduler
  forks: SubagentSpec[]
  setForkThrow: (e: Error | null) => void
  setForkId: (id: SubagentHandleId) => void
}

const fakeScheduler = (): FakeScheduler => {
  const forks: SubagentSpec[] = []
  let nextId: SubagentHandleId = "bg-new-0001"
  let counter = 0
  let throwErr: Error | null = null
  const scheduler: BackgroundSubagentScheduler = {
    fork(spec) {
      if (throwErr !== null) throw throwErr
      forks.push(spec)
      counter += 1
      // If the test set a fixed id, use it for the FIRST fork only — later
      // forks use counter-derived ids so multi-fork tests get distinct ids.
      const id = counter === 1 ? nextId : (`bg-new-${counter.toString().padStart(4, "0")}` as const)
      return id
    },
    poll(): SubagentResult | null {
      return null
    },
    async await(): Promise<SubagentResult | null> {
      return null
    },
    cancel(): boolean {
      return false
    },
    list(): ReadonlyArray<{
      id: SubagentHandleId
      result: SubagentResult
      spec: SubagentSpec
    }> {
      return []
    },
    prune(): number {
      return 0
    },
    serialize(): string {
      return ""
    },
    hydrate(): number {
      return 0
    },
    hydrateWithPrune(): { restored: number; pruned: number } {
      return { restored: 0, pruned: 0 }
    },
    forceBackground(): ForceBackgroundOutcome {
      // The fake has no admission queue, so nothing can be promoted.
      return "queue_disabled"
    },
  }
  return {
    scheduler,
    forks,
    setForkThrow: (e) => {
      throwErr = e
    },
    setForkId: (id) => {
      nextId = id
    },
  }
}

interface FakeStore {
  store: PersistentSchedulerStore
  seed: (workspace: string, handles: PersistedHandle[]) => void
  saved: PersistedHandle[]
  setSaveThrow: (e: Error | null) => void
  setListThrow: (e: Error | null) => void
}

const fakeStore = (): FakeStore => {
  const byWorkspace = new Map<string, PersistedHandle[]>()
  const saved: PersistedHandle[] = []
  let saveErr: Error | null = null
  let listErr: Error | null = null
  const store: PersistentSchedulerStore = {
    async save(h) {
      if (saveErr !== null) throw saveErr
      saved.push(h)
    },
    async load() {
      return null
    },
    async list(workspace) {
      if (listErr !== null) throw listErr
      return byWorkspace.get(workspace) ?? []
    },
    async delete() {
      /* no-op */
    },
    async prune() {
      return 0
    },
  }
  return {
    store,
    seed: (workspace, handles) => {
      byWorkspace.set(workspace, handles)
    },
    saved,
    setSaveThrow: (e) => {
      saveErr = e
    },
    setListThrow: (e) => {
      listErr = e
    },
  }
}

/** Stub policy whose `decide` returns the canned decision (or throws). */
const stubPolicy = (
  decision: ResumeDecision | ((h: PersistedHandle) => ResumeDecision),
  opts?: { throwErr?: Error },
): ResumePolicy => ({
  decide(h: PersistedHandle): ResumeDecision {
    if (opts?.throwErr) throw opts.throwErr
    return typeof decision === "function" ? decision(h) : decision
  },
})

/* ====================================================================== */
/* A. defaultResumePolicy (8)                                              */
/* ====================================================================== */

describe("A. defaultResumePolicy", () => {
  test("HG-01: legacy idempotent metadata cannot self-authorize restart replay", () => {
    const policy = defaultResumePolicy({ now: () => 1_000_000 })
    const h = mkHandle({ id: "bg-1", spec: { task: "t", metadata: { idempotent: "true" } } })
    const d = policy.decide(h)
    expect(d.action).toBe("skip")
  })

  test("HG-02: age > default 24h → mark-failed", () => {
    const tNow = 100_000_000
    const policy = defaultResumePolicy({ now: () => tNow })
    const h = mkHandle({ id: "bg-2", startedAt: tNow - 25 * 60 * 60 * 1000 })
    const d = policy.decide(h)
    expect(d.action).toBe("mark-failed")
    if (d.action === "mark-failed") expect(d.reason).toContain("stale")
  })

  test("HG-03: maxTurns=10, turns=9 (90% ≥ 80%) → mark-failed (likely looped)", () => {
    const policy = defaultResumePolicy({ now: () => 1_000_000 })
    const h = mkHandle({
      id: "bg-3",
      startedAt: 999_000,
      spec: { task: "t", maxTurns: 10 },
      turns: 9,
    })
    const d = policy.decide(h)
    expect(d.action).toBe("mark-failed")
    if (d.action === "mark-failed") expect(d.reason).toContain("looped")
  })

  test("HG-04: maxTurns=10, turns=7 (70% < 80%) → skip", () => {
    const policy = defaultResumePolicy({ now: () => 1_000_000 })
    const h = mkHandle({
      id: "bg-4",
      startedAt: 999_000,
      spec: { task: "t", maxTurns: 10 },
      turns: 7,
    })
    const d = policy.decide(h)
    expect(d.action).toBe("skip")
  })

  test("HG-05: fresh handle, low turns → skip (user inspects)", () => {
    const policy = defaultResumePolicy({ now: () => 1_000_000 })
    const h = mkHandle({ id: "bg-5", startedAt: 999_500, turns: 1 })
    const d = policy.decide(h)
    expect(d.action).toBe("skip")
  })

  test("HG-06: legacy idempotent metadata cannot bypass stale rejection", () => {
    const tNow = 100_000_000
    const policy = defaultResumePolicy({ now: () => tNow })
    const h = mkHandle({
      id: "bg-6",
      startedAt: tNow - 48 * 60 * 60 * 1000,
      spec: { task: "t", metadata: { idempotent: "true" } },
    })
    const d = policy.decide(h)
    expect(d.action).toBe("mark-failed")
  })

  test("HG-07: opts.maxAgeMs override (1h) → 2h-old → mark-failed", () => {
    const tNow = 100_000_000
    const policy = defaultResumePolicy({ now: () => tNow, maxAgeMs: 60 * 60 * 1000 })
    const h = mkHandle({ id: "bg-7", startedAt: tNow - 2 * 60 * 60 * 1000 })
    const d = policy.decide(h)
    expect(d.action).toBe("mark-failed")
  })

  test("HG-08: opts.staleTurnsRatio=0.5 → turns=6/maxTurns=10 (60%) → mark-failed", () => {
    const policy = defaultResumePolicy({ now: () => 1_000_000, staleTurnsRatio: 0.5 })
    const h = mkHandle({
      id: "bg-8",
      startedAt: 999_000,
      spec: { task: "t", maxTurns: 10 },
      turns: 6,
    })
    const d = policy.decide(h)
    expect(d.action).toBe("mark-failed")
  })
})

/* ====================================================================== */
/* B. alwaysResumePolicy + askUserResumePolicy (3)                         */
/* ====================================================================== */

describe("B. alwaysResume + askUser", () => {
  test("HG-09: alwaysResumePolicy → resume on a stale handle", () => {
    const h = mkHandle({ id: "bg-9", startedAt: 0, turns: 10_000 })
    const d = alwaysResumePolicy.decide(h)
    expect(d.action).toBe("resume")
  })

  test("HG-10: askUserResumePolicy → ask-user with promptHint containing task head", () => {
    const h = mkHandle({ id: "bg-10", spec: { task: "fix a difficult bug" }, turns: 3 })
    const d = askUserResumePolicy.decide(h)
    expect(d.action).toBe("ask-user")
    if (d.action === "ask-user") {
      expect(d.promptHint).toContain("bg-10")
      expect(d.promptHint).toContain("fix a difficult bug")
    }
  })

  test("HG-11: askUserResumePolicy truncates very long task in promptHint", () => {
    const longTask = "x".repeat(200)
    const h = mkHandle({ id: "bg-11", spec: { task: longTask } })
    const d = askUserResumePolicy.decide(h)
    expect(d.action).toBe("ask-user")
    if (d.action === "ask-user") {
      // Truncation marker (…) present.
      expect(d.promptHint).toContain("…")
    }
  })
})

/* ====================================================================== */
/* C. resumeInterruptedHandles (11)                                        */
/* ====================================================================== */

describe("C. resumeInterruptedHandles", () => {
  test("HG-12: store has 0 interrupted handles → returns []", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [
      mkHandle({ id: "bg-done", status: "completed" }),
      mkHandle({ id: "bg-fail", status: "failed" }),
    ])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })
    expect(out).toEqual([])
    expect(sched.forks).toHaveLength(0)
  })

  test("HG-13: resume decision → scheduler.fork called + outcome.newId set", async () => {
    const sched = fakeScheduler()
    sched.setForkId("bg-reborn-1")
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-int-1", spec: { task: "do work" } })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 5000,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.newId).toBe("bg-reborn-1")
    expect(out[0]?.decision.action).toBe("resume")
    expect(sched.forks).toHaveLength(1)
  })

  test("HG-14: skip decision → no fork, no save, decision recorded", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-int-2" })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: stubPolicy({ action: "skip", reason: "user inspects" }),
      workspace: "/ws/R",
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.decision.action).toBe("skip")
    expect(sched.forks).toHaveLength(0)
    expect(store.saved).toHaveLength(0)
  })

  test("HG-15: mark-failed → store.save with status=failed + errorMessage", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-int-3" })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: stubPolicy({ action: "mark-failed", reason: "too old" }),
      workspace: "/ws/R",
      now: () => 12345,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.decision.action).toBe("mark-failed")
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.status).toBe("failed")
    expect(store.saved[0]?.errorMessage).toBe("too old")
    expect(store.saved[0]?.endedAt).toBe(12345)
    expect(sched.forks).toHaveLength(0)
  })

  test("HG-16: ask-user → no scheduler call, promptHint surfaced", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-int-4" })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: askUserResumePolicy,
      workspace: "/ws/R",
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.decision.action).toBe("ask-user")
    if (out[0]?.decision.action === "ask-user") {
      expect(out[0]?.decision.promptHint).toContain("bg-int-4")
    }
    expect(sched.forks).toHaveLength(0)
    expect(store.saved).toHaveLength(0)
  })

  test("HG-17: scheduler.fork throws → outcome.errorMessage set, iteration continues", async () => {
    const sched = fakeScheduler()
    sched.setForkThrow(new Error("cap-exceeded"))
    const store = fakeStore()
    store.seed("/ws/R", [
      mkHandle({ id: "bg-int-5" }),
      mkHandle({ id: "bg-int-6", startedAt: 2000 }),
    ])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })
    expect(out).toHaveLength(2) // iteration continued past the throw
    expect(out[0]?.errorMessage).toContain("scheduler.fork")
    expect(out[1]?.errorMessage).toContain("scheduler.fork")
  })

  test("HG-18: mixed 3 handles (resume/skip/mark-failed) → 3 outcomes in store order", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [
      mkHandle({ id: "bg-A" }),
      mkHandle({ id: "bg-B" }),
      mkHandle({ id: "bg-C" }),
    ])
    const policy: ResumePolicy = {
      decide(h) {
        if (h.id === "bg-A") return { action: "resume", reason: "idempotent" }
        if (h.id === "bg-B") return { action: "skip", reason: "user" }
        return { action: "mark-failed", reason: "stale" }
      },
    }
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy,
      workspace: "/ws/R",
    })
    expect(out.map((o) => o.id)).toEqual(["bg-A", "bg-B", "bg-C"])
    expect(out.map((o) => o.decision.action)).toEqual(["resume", "skip", "mark-failed"])
    expect(sched.forks).toHaveLength(1)
    expect(store.saved).toHaveLength(2) // resume marks old + mark-failed
  })

  test("HG-19: resume → OLD handle saved with status='resumed' and outputSummary='resumed as <newId>'", async () => {
    const sched = fakeScheduler()
    sched.setForkId("bg-fresh-X")
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-old-Y", startedAt: 500, turns: 2 })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 9000,
    })
    expect(out[0]?.newId).toBe("bg-fresh-X")
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.id).toBe("bg-old-Y")
    expect(store.saved[0]?.status).toBe("resumed")
    expect(store.saved[0]?.outputSummary).toBe("resumed as bg-fresh-X")
    expect(store.saved[0]?.endedAt).toBe(9000)
  })

  test("HG-20: resume → newly-forked spec.metadata.resumedFrom = oldId", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [
      mkHandle({
        id: "bg-origin",
        spec: { task: "T", maxTurns: 5, metadata: { caller: "ci" } },
      }),
    ])
    await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })
    expect(sched.forks).toHaveLength(1)
    const forkedSpec = sched.forks[0]
    expect(forkedSpec?.task).toBe("T")
    expect(forkedSpec?.maxTurns).toBe(5)
    expect(forkedSpec?.metadata?.resumedFrom).toBe("bg-origin")
    expect(forkedSpec?.metadata?.caller).toBe("ci") // preserved
  })

  test("HG-21: cross-workspace → only target workspace's interrupted considered", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-mine", workspace: "/ws/R" })])
    store.seed("/ws/OTHER", [mkHandle({ id: "bg-theirs", workspace: "/ws/OTHER" })])
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("bg-mine")
  })

  test("HG-22: policy.decide throws → outcome.errorMessage set, iteration continues", async () => {
    const sched = fakeScheduler()
    const store = fakeStore()
    store.seed("/ws/R", [mkHandle({ id: "bg-int-X" }), mkHandle({ id: "bg-int-Y" })])
    const policy = stubPolicy({ action: "skip", reason: "unused" }, { throwErr: new Error("boom") })
    const out = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: store.store,
      policy,
      workspace: "/ws/R",
    })
    expect(out).toHaveLength(2)
    expect(out[0]?.errorMessage).toContain("policy.decide")
    expect(out[1]?.errorMessage).toContain("policy.decide")
    // synthetic decision is "skip" so no fork / no save.
    expect(sched.forks).toHaveLength(0)
    expect(store.saved).toHaveLength(0)
  })
})
