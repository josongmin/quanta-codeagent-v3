/**
 * Subagent conversation-replay hellgate — ADR-0166 Phase 2.5.
 *
 * Seals the conversation-seed replay surface that sits on top of ADR-0159:
 *
 *   A. defaultReplayPolicy                (5)
 *   B. alwaysReplay + skipReplay          (2)
 *   C. buildReplaySpec (composer)         (6)
 *   D. Resumer integration                (4)
 *
 * Total = 17 cases. Uses an in-memory `ConversationCheckpointStore` (from
 * ADR-0124) + the fake scheduler + fake persistence store from
 * subagent-resume-hellgate.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type {
  BackgroundSubagentScheduler,
  ForceBackgroundOutcome,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
} from "@/agent/subagent-background"
import type { PersistedHandle, PersistentSchedulerStore } from "@/agent/subagent-persistence-store"
import {
  alwaysReplayPolicy,
  alwaysResumePolicy,
  buildReplaySpec,
  defaultReplayPolicy,
  type ReplayContext,
  resumeInterruptedHandles,
  skipReplayPolicy,
} from "@/agent/subagent-resume"
import type { Message } from "@/llm"

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
  ...(over.conversationSnapshotId !== undefined
    ? { conversationSnapshotId: over.conversationSnapshotId }
    : {}),
})

const mkMsg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const mkMsgs = (n: number, prefix = "m"): Message[] => {
  const arr: Message[] = []
  for (let i = 0; i < n; i += 1) {
    arr.push(mkMsg(i % 2 === 0 ? "user" : "assistant", `${prefix}-${i}`))
  }
  return arr
}

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
    poll(): SubagentResult | null {
      return null
    },
    async await(): Promise<SubagentResult | null> {
      return null
    },
    cancel(): boolean {
      return false
    },
    forceBackground(): ForceBackgroundOutcome {
      return "queue_disabled"
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
  }
  return { scheduler, forks }
}

interface FakeStore {
  store: PersistentSchedulerStore
  seed: (workspace: string, handles: PersistedHandle[]) => void
  saved: PersistedHandle[]
}

const fakeStore = (): FakeStore => {
  const byWorkspace = new Map<string, PersistedHandle[]>()
  const saved: PersistedHandle[] = []
  const store: PersistentSchedulerStore = {
    async save(h) {
      saved.push(h)
    },
    async load() {
      return null
    },
    async list(workspace) {
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
  }
}

/* ====================================================================== */
/* A. defaultReplayPolicy (5)                                              */
/* ====================================================================== */

describe("A. defaultReplayPolicy", () => {
  test("HG-A1: snapshot null → skip-replay", () => {
    const policy = defaultReplayPolicy()
    const h = mkHandle({ id: "h1" })
    const d = policy.decide(h, null)
    expect(d.action).toBe("skip-replay")
    if (d.action === "skip-replay") expect(d.reason.toLowerCase()).toContain("null")
  })

  test("HG-A2: snapshot empty → skip-replay", () => {
    const policy = defaultReplayPolicy()
    const h = mkHandle({ id: "h2" })
    const d = policy.decide(h, [])
    expect(d.action).toBe("skip-replay")
    if (d.action === "skip-replay") expect(d.reason.toLowerCase()).toContain("empty")
  })

  test("HG-A3: snapshot length ≤ maxMessages → replay-all", () => {
    const policy = defaultReplayPolicy({ maxMessages: 10 })
    const h = mkHandle({ id: "h3" })
    const snap = mkMsgs(5)
    const d = policy.decide(h, snap)
    expect(d.action).toBe("replay-all")
  })

  test("HG-A4: snapshot length > maxMessages → replay-truncated with keepLastN=max", () => {
    const policy = defaultReplayPolicy({ maxMessages: 3 })
    const h = mkHandle({ id: "h4" })
    const snap = mkMsgs(10)
    const d = policy.decide(h, snap)
    expect(d.action).toBe("replay-truncated")
    if (d.action === "replay-truncated") {
      expect(d.keepLastN).toBe(3)
      expect(d.reason).toContain("tail-keep")
    }
  })

  test("HG-A5: opts.maxMessages override applies (caller can downscale)", () => {
    // Default 200 ≥ 50 ⇒ would be replay-all; override to 4 ⇒ truncated.
    const policy = defaultReplayPolicy({ maxMessages: 4 })
    const h = mkHandle({ id: "h5" })
    const snap = mkMsgs(50)
    const d = policy.decide(h, snap)
    expect(d.action).toBe("replay-truncated")
    if (d.action === "replay-truncated") expect(d.keepLastN).toBe(4)
  })
})

/* ====================================================================== */
/* B. alwaysReplay + skipReplay (2)                                        */
/* ====================================================================== */

describe("B. alwaysReplay + skipReplay", () => {
  test("HG-B1: alwaysReplayPolicy → replay-all even on empty snapshot", () => {
    const h = mkHandle({ id: "hB1" })
    expect(alwaysReplayPolicy.decide(h, []).action).toBe("replay-all")
    expect(alwaysReplayPolicy.decide(h, null).action).toBe("replay-all")
    expect(alwaysReplayPolicy.decide(h, mkMsgs(3)).action).toBe("replay-all")
  })

  test("HG-B2: skipReplayPolicy → skip-replay unconditionally", () => {
    const h = mkHandle({ id: "hB2" })
    expect(skipReplayPolicy.decide(h, null).action).toBe("skip-replay")
    expect(skipReplayPolicy.decide(h, mkMsgs(100)).action).toBe("skip-replay")
  })
})

/* ====================================================================== */
/* C. buildReplaySpec (6)                                                  */
/* ====================================================================== */

describe("C. buildReplaySpec", () => {
  test("HG-C1: checkpointStore=null → seedMessages=[], replayPolicy=skip-replay", async () => {
    const h = mkHandle({ id: "hC1", conversationSnapshotId: "snap-1" })
    const ctx: ReplayContext = { checkpointStore: null }
    const out = await buildReplaySpec(h, ctx, defaultReplayPolicy())
    expect(out.seedMessages).toEqual([])
    expect(out.replayMetadata.replayPolicy).toBe("skip-replay")
    expect(out.replayMetadata.replayCount).toBe("0")
    expect(out.replayMetadata.resumedFrom).toBe("hC1")
    expect(out.replayMetadata.replayReason).toContain("null")
  })

  test("HG-C2: no snapshotId on handle → skip-replay (absent)", async () => {
    const store = defaultConversationCheckpointStore()
    const h = mkHandle({ id: "hC2" }) // no conversationSnapshotId
    const out = await buildReplaySpec(h, { checkpointStore: store }, defaultReplayPolicy())
    expect(out.seedMessages).toEqual([])
    expect(out.replayMetadata.replayPolicy).toBe("skip-replay")
    expect(out.replayMetadata.replayReason).toContain("absent")
  })

  test("HG-C3: store hit + replay-all → seedMessages=N, replayCount=N", async () => {
    const store = defaultConversationCheckpointStore()
    const msgs = mkMsgs(4)
    store.record("snap-3", msgs)
    const h = mkHandle({ id: "hC3", conversationSnapshotId: "snap-3" })
    const out = await buildReplaySpec(h, { checkpointStore: store }, defaultReplayPolicy())
    expect(out.seedMessages.length).toBe(4)
    expect(out.replayMetadata.replayPolicy).toBe("replay-all")
    expect(out.replayMetadata.replayCount).toBe("4")
    expect(out.replayMetadata.resumedFrom).toBe("hC3")
  })

  test("HG-C4: store hit + truncated → seedMessages.length=keepLastN, last N preserved (tail-keep)", async () => {
    const store = defaultConversationCheckpointStore()
    const msgs = mkMsgs(10, "m")
    store.record("snap-4", msgs)
    const h = mkHandle({ id: "hC4", conversationSnapshotId: "snap-4" })
    const policy = defaultReplayPolicy({ maxMessages: 3 })
    const out = await buildReplaySpec(h, { checkpointStore: store }, policy)
    expect(out.seedMessages.length).toBe(3)
    expect(out.replayMetadata.replayPolicy).toBe("replay-truncated")
    // tail-keep: must preserve LAST 3 (m-7, m-8, m-9).
    const lastTexts = out.seedMessages.map((m) =>
      m.content[0]?.type === "text" ? m.content[0].text : "",
    )
    expect(lastTexts).toEqual(["m-7", "m-8", "m-9"])
    expect(out.replayMetadata.replayCount).toBe("3")
  })

  test("HG-C5: store.restore throws → seedMessages=[], skip-replay with store-failed reason", async () => {
    const baseStore = defaultConversationCheckpointStore()
    const throwingStore = {
      ...baseStore,
      restore() {
        throw new Error("disk read failed")
      },
    }
    const h = mkHandle({ id: "hC5", conversationSnapshotId: "snap-5" })
    const out = await buildReplaySpec(h, { checkpointStore: throwingStore }, defaultReplayPolicy())
    expect(out.seedMessages).toEqual([])
    expect(out.replayMetadata.replayPolicy).toBe("skip-replay")
    expect(out.replayMetadata.replayReason).toContain("store-failed")
    expect(out.replayMetadata.replayReason).toContain("disk read failed")
  })

  test("HG-C6: metadata includes resumedFrom + replayCount + replayPolicy + replayReason (always)", async () => {
    const store = defaultConversationCheckpointStore()
    store.record("snap-6", mkMsgs(2))
    const h = mkHandle({ id: "hC6", conversationSnapshotId: "snap-6" })
    const out = await buildReplaySpec(h, { checkpointStore: store }, alwaysReplayPolicy)
    expect(out.replayMetadata.resumedFrom).toBe("hC6")
    expect(out.replayMetadata.replayCount).toBe("2")
    expect(out.replayMetadata.replayPolicy).toBe("replay-all")
    expect(typeof out.replayMetadata.replayReason).toBe("string")
    // exactOptional: every value is a string (Record<string,string>).
    for (const v of Object.values(out.replayMetadata)) {
      expect(typeof v).toBe("string")
    }
  })
})

/* ====================================================================== */
/* D. Resumer integration (4)                                              */
/* ====================================================================== */

describe("D. Resumer integration (resumeInterruptedHandles + replay wire)", () => {
  test("HG-D1: replay NOT wired → Phase 2 byte-identical (no replay metadata, no seedMessages)", async () => {
    const sched = fakeScheduler()
    const st = fakeStore()
    const h = mkHandle({
      id: "bg-D1",
      conversationSnapshotId: "snap-D1", // even with snapshot id, no wire = no replay
      spec: { task: "t", metadata: { origin: "ci" } },
    })
    st.seed("/ws/R", [h])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.replayMetadata).toBeUndefined()
    expect(outcomes[0]?.seedMessages).toBeUndefined()
    // New fork spec.metadata must NOT carry replay-audit keys.
    expect(sched.forks.length).toBe(1)
    const md = sched.forks[0]?.metadata ?? {}
    expect(md.resumedFrom).toBe("bg-D1")
    expect(md.replayPolicy).toBeUndefined()
    expect(md.replayCount).toBeUndefined()
    expect(md.origin).toBe("ci") // pre-existing key preserved
  })

  test("HG-D2: replay wired → seedMessages set + replayMetadata in outcome + merged into spec.metadata", async () => {
    const sched = fakeScheduler()
    const st = fakeStore()
    const ckpt = defaultConversationCheckpointStore()
    ckpt.record("snap-D2", mkMsgs(3, "D2"))
    const h = mkHandle({
      id: "bg-D2",
      conversationSnapshotId: "snap-D2",
      spec: { task: "t", metadata: { origin: "test" } },
    })
    st.seed("/ws/R", [h])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
      replay: { context: { checkpointStore: ckpt }, policy: alwaysReplayPolicy },
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.seedMessages?.length).toBe(3)
    expect(outcomes[0]?.replayMetadata?.replayPolicy).toBe("replay-all")
    expect(outcomes[0]?.replayMetadata?.replayCount).toBe("3")
    // Spec metadata merge — replay keys plus pre-existing key plus resumedFrom.
    const md = sched.forks[0]?.metadata ?? {}
    expect(md.resumedFrom).toBe("bg-D2") // chain link overwrites if set
    expect(md.replayPolicy).toBe("replay-all")
    expect(md.replayCount).toBe("3")
    expect(md.origin).toBe("test")
  })

  test("HG-D3: replay wired but no snapshot id on handle → outcome.replayMetadata present (skip-replay), no seedMessages, byte-identical fork spec.metadata to Phase 2", async () => {
    const sched = fakeScheduler()
    const st = fakeStore()
    const ckpt = defaultConversationCheckpointStore()
    const h = mkHandle({
      id: "bg-D3",
      // no conversationSnapshotId
      spec: { task: "t", metadata: { origin: "ci" } },
    })
    st.seed("/ws/R", [h])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
      replay: { context: { checkpointStore: ckpt }, policy: defaultReplayPolicy() },
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.replayMetadata?.replayPolicy).toBe("skip-replay")
    expect(outcomes[0]?.replayMetadata?.replayCount).toBe("0")
    // No seedMessages surfaced on skip (empty array is OMITTED, not set to []).
    expect(outcomes[0]?.seedMessages).toBeUndefined()
    // Spec metadata STILL gets the skip-replay audit fields merged — caller can
    // confirm orchestrator at least consulted the composer.
    const md = sched.forks[0]?.metadata ?? {}
    expect(md.resumedFrom).toBe("bg-D3")
    expect(md.replayPolicy).toBe("skip-replay")
    expect(md.replayCount).toBe("0")
    expect(md.origin).toBe("ci")
  })

  test("HG-D4: chained resume — newly-forked spec.metadata.resumedFrom points to old, replayMetadata persists across chain hop", async () => {
    const sched = fakeScheduler()
    const st = fakeStore()
    const ckpt = defaultConversationCheckpointStore()
    ckpt.record("snap-D4", mkMsgs(2, "D4"))
    const h1 = mkHandle({
      id: "bg-D4-old",
      conversationSnapshotId: "snap-D4",
      // simulate this handle ITSELF was previously resumed from "bg-D4-older"
      spec: { task: "t", metadata: { resumedFrom: "bg-D4-older", origin: "ci" } },
    })
    st.seed("/ws/R", [h1])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 100,
      replay: { context: { checkpointStore: ckpt }, policy: alwaysReplayPolicy },
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.id).toBe("bg-D4-old")
    expect(outcomes[0]?.newId).toBe("bg-new-0001")
    // Chain link: resumedFrom in new spec metadata MUST be the immediate
    // predecessor (bg-D4-old), NOT the older handle the predecessor cited.
    const md = sched.forks[0]?.metadata ?? {}
    expect(md.resumedFrom).toBe("bg-D4-old")
    expect(md.origin).toBe("ci") // pre-existing metadata preserved across hop
    expect(md.replayPolicy).toBe("replay-all")
    expect(md.replayCount).toBe("2")
    // Old handle was flipped to "resumed" with outputSummary linking to new id.
    expect(st.saved.length).toBe(1)
    expect(st.saved[0]?.status).toBe("resumed")
    expect(st.saved[0]?.outputSummary).toBe("resumed as bg-new-0001")
  })
})
