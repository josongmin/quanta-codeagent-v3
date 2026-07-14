/**
 * Subagent resume DEPTH-PRESERVATION hellgate — INV-09 / INV-10.
 *
 * Context (traced re-derivation path):
 *   resumer.ts:~291  scheduler.fork(buildResumedSpec(handle, replayMetadata))
 *     → subagent-background/engine.ts:257  specToRequest(spec, signal, parentDepth)
 *          where `parentDepth` is captured at scheduler CONSTRUCTION
 *          (engine.ts:287 `opts.parentDepth ?? 0`), NOT from the persisted handle
 *     → subagent-background.ts:331  req.depth = parentDepth + 1        (ADVISORY)
 *     → subagent-runner.ts:654  depth: childDepthOf(parent)            (AUTHORITY)
 *
 * So a resumed child's REAL depth is re-derived from the RESUME-TIME parent,
 * never the depth the child originally ran at. Under cap>=2 a persisted
 * depth-2 child could be re-derived to a shallower depth and gain spawn
 * authority it should not have.
 *
 * Because the runner's depth authority is `childDepthOf(resume-time-parent)`
 * (fixed by the injected scheduler's construction-time parentDepth) and the
 * resumer's ONLY seam is `scheduler.fork(spec)` (req.depth is advisory-only),
 * the resumer CANNOT force the fork to run at the persisted depth. The
 * fail-closed lever it DOES own: compare the persisted lineage depth against
 * the depth the injected scheduler will actually run a resumed fork at
 * (`lineageGuard.resumeForkDepth`) and DENY the auto-resume on any divergence.
 *
 *   INV-09: persisted depth != resumeForkDepth  → DENY (would re-derive; a
 *           shallower re-derivation grants spawn authority).
 *   INV-10: persisted depth ABSENT (legacy record) → DENY (fail-closed; do NOT
 *           silently resume at the re-derived — possibly root — depth).
 *
 * Default-OFF: when `lineageGuard` is ABSENT the orchestrator is byte-identical
 * to the pre-INV-09 path (the shipping cap=1 path never sets a guard).
 */

import { describe, expect, test } from "bun:test"
import type {
  BackgroundSubagentScheduler,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
} from "@/agent/subagent-background"
import type { PersistedHandle, PersistentSchedulerStore } from "@/agent/subagent-persistence-store"
import { alwaysResumePolicy, resumeInterruptedHandles } from "@/agent/subagent-resume"

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
  ...(over.depth !== undefined ? { depth: over.depth } : {}),
  ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
})

interface FakeScheduler {
  scheduler: BackgroundSubagentScheduler
  forks: SubagentSpec[]
}

const fakeScheduler = (): FakeScheduler => {
  const forks: SubagentSpec[] = []
  let counter = 0
  const scheduler: BackgroundSubagentScheduler = {
    fork(spec) {
      forks.push(spec)
      counter += 1
      return `bg-new-${counter.toString().padStart(4, "0")}` as SubagentHandleId
    },
    poll: (): SubagentResult | null => null,
    await: async (): Promise<SubagentResult | null> => null,
    cancel: (): boolean => false,
    list: () => [],
    prune: (): number => 0,
    serialize: (): string => "",
    hydrate: (): number => 0,
    hydrateWithPrune: () => ({ restored: 0, pruned: 0 }),
    forceBackground: () => "not_found",
  }
  return { scheduler, forks }
}

const fakeStore = (
  handles: PersistedHandle[],
): PersistentSchedulerStore & { saved: PersistedHandle[] } => {
  const saved: PersistedHandle[] = []
  return {
    saved,
    async save(h) {
      saved.push(h)
    },
    async load() {
      return null
    },
    async list() {
      return handles
    },
    async delete() {},
    async prune() {
      return 0
    },
  }
}

/* ====================================================================== */
/* codec round-trip (types + jsonl)                                        */
/* ====================================================================== */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultJsonlSchedulerStore } from "@/agent/subagent-persistence-store"

describe("PersistedHandle.depth codec round-trip", () => {
  test("depth survives save → list (jsonl codec preserves the lineage depth)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      const h = mkHandle({ id: "bg-d2", depth: 2, workspace: "/ws/D", status: "interrupted" })
      await store.save(h)
      const back = await store.list("/ws/D")
      expect(back).toHaveLength(1)
      // RED before impl: parseHandle drops the depth field.
      expect(back[0]?.depth).toBe(2)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("legacy record with NO depth still parses (backward compatible)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      const h = mkHandle({ id: "bg-legacy", workspace: "/ws/L", status: "interrupted" })
      await store.save(h)
      const back = await store.list("/ws/L")
      expect(back).toHaveLength(1)
      expect(back[0]?.id).toBe("bg-legacy")
      expect(back[0]?.depth).toBeUndefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/* ====================================================================== */
/* PERSIST-TIME CAPTURE: hydrating-scheduler writes handle.depth            */
/* ====================================================================== */

import type {
  BackgroundSubagentScheduler as BgSched,
  SubagentHandleId as HId,
} from "@/agent/subagent-background"
import {
  type PersistentSchedulerStore as PStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"

/** A minimal in-memory inner scheduler whose `fork` immediately registers a
 *  running entry (so the wrapper's fork-time `saveLiveHandle` has a live record
 *  to project). `await` never settles within the test window — we only observe
 *  the fork-time running snapshot the wrapper persists. */
const innerWithOneRunning = (): { inner: BgSched; forkedId: HId } => {
  const id = "bg-cap-0001" as HId
  const spec: SubagentSpec = { task: "work" }
  const result: SubagentResult = {
    status: "running",
    outputSummary: "(running)",
    startedAt: 5000,
    turns: 0,
  }
  const entries = [{ id, spec, result }]
  const inner: BgSched = {
    fork: () => id,
    poll: (q) => (q === id ? result : null),
    await: () => new Promise<SubagentResult | null>(() => {}), // never settles
    cancel: () => false,
    list: () => entries,
    prune: () => 0,
    serialize: () => "",
    hydrate: () => 0,
    hydrateWithPrune: () => ({ restored: 0, pruned: 0 }),
    forceBackground: () => "not_found",
  }
  return { inner, forkedId: id }
}

const capturingStore = (): PStore & { saved: PersistedHandle[] } => {
  const saved: PersistedHandle[] = []
  return {
    saved,
    async save(h) {
      saved.push(h)
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
}

describe("persist-time capture — hydrating scheduler records lineage depth", () => {
  test("RED before wire: fork persists handle.depth = injected childDepth", async () => {
    const { inner } = innerWithOneRunning()
    const store = capturingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner,
      store,
      workspace: "/ws/cap",
      childDepth: 2, // the REAL depth bg children run at (= parentDepth+1)
    })
    sched.fork({ task: "work" })
    // Let the fire-and-forget fork-time save drain.
    await Promise.resolve()
    await Promise.resolve()
    const running = store.saved.find((h) => h.status === "running")
    expect(running).toBeDefined()
    // RED until liveToPersisted threads the injected childDepth.
    expect(running?.depth).toBe(2)
  })

  test("backward-compatible: no childDepth ⇒ handle.depth ABSENT", async () => {
    const { inner } = innerWithOneRunning()
    const store = capturingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner,
      store,
      workspace: "/ws/cap",
      // childDepth omitted
    })
    sched.fork({ task: "work" })
    await Promise.resolve()
    await Promise.resolve()
    const running = store.saved.find((h) => h.status === "running")
    expect(running).toBeDefined()
    expect(running?.depth).toBeUndefined()
  })
})

describe("full round-trip — capture (wrapper+jsonl) → resume guard", () => {
  test("depth-2 child persisted via wrapper → matching resume allowed, divergent+legacy denied", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-rt-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      // 1) Persist a bg child at depth 2 through the REAL hydrating wrapper +
      //    jsonl store (capture wire), then flip it to interrupted so the
      //    resumer will consider it.
      const { inner } = innerWithOneRunning()
      const sched = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace: "/ws/rt",
        childDepth: 2,
      })
      sched.fork({ task: "work" })
      // The wrapper's fork-time running save is fire-and-forget through an async
      // jsonl disk write; poll deterministically until it lands (bounded).
      let persistedRunning: PersistedHandle | null = null
      for (let i = 0; i < 200 && persistedRunning === null; i += 1) {
        persistedRunning = await store.load("bg-cap-0001")
        if (persistedRunning === null) await new Promise((r) => setTimeout(r, 5))
      }
      // Read back the running snapshot the wrapper persisted and assert depth
      // round-tripped through the jsonl codec.
      expect(persistedRunning?.depth).toBe(2)
      // Mark it interrupted (as hydration-on-restart would) so the resumer picks
      // it up — preserving the captured depth.
      await store.save({
        ...(persistedRunning as PersistedHandle),
        status: "interrupted",
        endedAt: 6000,
        outputSummary: "(interrupted)",
      })

      const forkSpy = fakeScheduler()

      // 2a) Resume under a scheduler whose resume-fork depth MATCHES (2) → allowed.
      const okOutcomes = await resumeInterruptedHandles({
        scheduler: forkSpy.scheduler,
        store,
        policy: alwaysResumePolicy,
        workspace: "/ws/rt",
        lineageGuard: { resumeForkDepth: 2 },
      })
      expect(okOutcomes).toHaveLength(1)
      expect(forkSpy.forks).toHaveLength(1)
      expect(okOutcomes[0]?.newId).toBeDefined()

      // Re-seed the interrupted record (the allowed resume flipped it to
      // "resumed") so the divergent/legacy legs start from interrupted again.
      const reseed = async (depth: number | undefined): Promise<void> => {
        await store.save({
          ...(persistedRunning as PersistedHandle),
          status: "interrupted",
          endedAt: 6000,
          outputSummary: "(interrupted)",
          ...(depth !== undefined ? { depth } : {}),
        })
      }

      // 2b) Divergent resume-fork depth (1) → DENIED, no fork.
      await reseed(2)
      const divergent = fakeScheduler()
      const divOutcomes = await resumeInterruptedHandles({
        scheduler: divergent.scheduler,
        store,
        policy: alwaysResumePolicy,
        workspace: "/ws/rt",
        lineageGuard: { resumeForkDepth: 1 },
      })
      expect(divergent.forks).toHaveLength(0)
      expect(divOutcomes[0]?.newId).toBeUndefined()
      expect(divOutcomes[0]?.errorMessage).toBeDefined()

      // 2c) Legacy (no depth) handle → DENIED even when resume-fork depth = 2.
      // Build a fresh legacy interrupted handle (jsonl codec drops depth when
      // absent — verified elsewhere).
      const legacyStore = fakeStore([mkHandle({ id: "bg-legacy-rt", status: "interrupted" })])
      const legacyFork = fakeScheduler()
      const legacyOutcomes = await resumeInterruptedHandles({
        scheduler: legacyFork.scheduler,
        store: legacyStore,
        policy: alwaysResumePolicy,
        workspace: "/ws/R",
        lineageGuard: { resumeForkDepth: 2 },
      })
      expect(legacyFork.forks).toHaveLength(0)
      expect(legacyOutcomes[0]?.errorMessage).toBeDefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/* ====================================================================== */
/* INV-09: preserve persisted depth (deny divergent re-derivation)         */
/* ====================================================================== */

describe("INV-09 — resume preserves persisted lineage depth", () => {
  test("RED: persisted depth-2 resumed where fork would run at a SHALLOWER depth → DENIED (no fork)", async () => {
    // Persisted child ran at depth 2. The resume-time scheduler would fork at
    // depth 1 (shallower) — that grants spawn authority it should not have.
    const handle = mkHandle({ id: "bg-d2", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 1 },
    })

    expect(outcomes).toHaveLength(1)
    // MUST NOT re-fork at a re-derived shallower depth.
    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
    // OLD handle must NOT be flipped to "resumed".
    expect(store.saved).toHaveLength(0)
  })

  test("GREEN path: persisted depth-2 resumed where fork runs at EXACTLY depth 2 → RESUMED", async () => {
    const handle = mkHandle({ id: "bg-d2ok", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 2 },
    })

    expect(outcomes).toHaveLength(1)
    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
    expect(outcomes[0]?.errorMessage).toBeUndefined()
    // OLD flipped to resumed.
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.status).toBe("resumed")
  })

  test("depth-2 resumed where fork would run DEEPER (depth 3) → also DENIED (any divergence)", async () => {
    const handle = mkHandle({ id: "bg-d2deep", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 3 },
    })

    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
  })
})

/* ====================================================================== */
/* INV-10: legacy no-depth handle → fail-closed (NOT root)                 */
/* ====================================================================== */

describe("INV-10 — legacy no-depth handle fails closed under a lineage guard", () => {
  test("no-depth handle + guard → DENIED (must NOT silently resume at re-derived/root depth)", async () => {
    const handle = mkHandle({ id: "bg-legacy", status: "interrupted" }) // NO depth
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      // Even if the resume-time fork depth is 0 (root) — must NOT auto-resume.
      lineageGuard: { resumeForkDepth: 0 },
    })

    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
    expect(store.saved).toHaveLength(0)
  })
})

/* ====================================================================== */
/* Default-OFF: no lineageGuard → byte-identical legacy resume             */
/* ====================================================================== */

describe("default-OFF — no lineageGuard preserves legacy behavior", () => {
  test("no guard: depth-2 handle still resumes (byte-identical to pre-INV-09)", async () => {
    const handle = mkHandle({ id: "bg-d2", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })

    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
  })

  test("no guard: legacy no-depth handle still resumes (unchanged)", async () => {
    const handle = mkHandle({ id: "bg-legacy", status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })

    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
  })
})
