/**
 * Subagent tool-history replay hellgate — ADR-0174 Phase 3.
 *
 * Seals the tool-history replay surface that sits on top of ADR-0166 (Phase
 * 2.5 conversation-seed replay):
 *
 *   A. IdempotencyClassifier                  (5)
 *   B. ToolCallRecord + JSONL store           (8)
 *   C. ToolReplayPolicy                       (8)
 *   D. replayToolHistory orchestrator         (5)
 *   E. Resumer integration                    (4)
 *
 * Total = 30 cases.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BackgroundSubagentScheduler,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
} from "@/agent/subagent-background"
import type { PersistedHandle, PersistentSchedulerStore } from "@/agent/subagent-persistence-store"
import {
  alwaysResumePolicy,
  DEFAULT_IDEMPOTENCY_TABLE,
  defaultIdempotencyClassifier,
  defaultJsonlToolHistoryStore,
  defaultToolReplayPolicy,
  hashToolArgs,
  type IdempotencyClassifier,
  replayToolHistory,
  resumeInterruptedHandles,
  type ShadowCommitRestorer,
  type ToolCallRecord,
  type ToolHistoryStore,
  type ToolReplayPolicy,
} from "@/agent/subagent-resume"

/* ====================================================================== */
/* fakes                                                                   */
/* ====================================================================== */

let tmpRoot: string
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "quanta-tool-replay-"))
})
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const mkRecord = (over: Partial<ToolCallRecord> & { toolUseId: string }): ToolCallRecord => ({
  toolUseId: over.toolUseId,
  toolName: over.toolName ?? "read",
  argsHash: over.argsHash ?? "deadbeefdeadbeef",
  result: over.result ?? { ok: true, output: "ok" },
  tier: over.tier ?? "pure",
  tsBefore: over.tsBefore ?? 1000,
  tsAfter: over.tsAfter ?? 1100,
  workspace: over.workspace ?? "/ws/R",
  ...(over.shadowCommit !== undefined ? { shadowCommit: over.shadowCommit } : {}),
  ...(over.sensitiveRedacted !== undefined ? { sensitiveRedacted: over.sensitiveRedacted } : {}),
})

const mkHandle = (over: Partial<PersistedHandle> & { id: string }): PersistedHandle => ({
  id: over.id,
  spec: over.spec ?? { task: "saved" },
  status: over.status ?? "interrupted",
  startedAt: over.startedAt ?? 1000,
  turns: over.turns ?? 0,
  outputSummary: over.outputSummary ?? "(interrupted)",
  workspace: over.workspace ?? "/ws/R",
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
    poll(): SubagentResult | null {
      return null
    },
    async await(): Promise<SubagentResult | null> {
      return null
    },
    cancel(): boolean {
      return false
    },
    forceBackground() {
      // This fake has no admission queue (fork throws-at-cap), so there is
      // nothing to promote — mirrors the default queue-disabled scheduler.
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

const fakePersistenceStore = (): FakeStore => {
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

/** In-memory tool-history store with explicit seeding. */
const memoryToolHistoryStore = (): {
  store: ToolHistoryStore
  seed: (handleId: string, recs: ToolCallRecord[]) => void
} => {
  const byHandle = new Map<string, ToolCallRecord[]>()
  const store: ToolHistoryStore = {
    async append(handleId, record) {
      const arr = byHandle.get(handleId) ?? []
      arr.push(record)
      byHandle.set(handleId, arr)
    },
    async list(handleId) {
      return byHandle.get(handleId) ?? []
    },
    async byToolUseId(handleId, toolUseId) {
      const arr = byHandle.get(handleId) ?? []
      let found: ToolCallRecord | null = null
      for (const r of arr) {
        if (r.toolUseId === toolUseId) found = r
      }
      return found
    },
    async clear(handleId) {
      const arr = byHandle.get(handleId) ?? []
      byHandle.delete(handleId)
      return arr.length
    },
  }
  return {
    store,
    seed: (handleId, recs) => {
      byHandle.set(handleId, recs.slice())
    },
  }
}

/* ====================================================================== */
/* A. IdempotencyClassifier (5)                                            */
/* ====================================================================== */

describe("A. IdempotencyClassifier", () => {
  test("HG-A1: 'read' → 'pure'", () => {
    expect(defaultIdempotencyClassifier().classify("read")).toBe("pure")
  })

  test("HG-A2: 'edit' → 'mutating-recoverable'", () => {
    expect(defaultIdempotencyClassifier().classify("edit")).toBe("mutating-recoverable")
  })

  test("HG-A3: 'bash' → 'mutating-external'", () => {
    expect(defaultIdempotencyClassifier().classify("bash")).toBe("mutating-external")
  })

  test("HG-A4: unknown tool → null (defensive)", () => {
    expect(defaultIdempotencyClassifier().classify("nonexistent_tool_xyz")).toBeNull()
    // empty + bizarre names → also null
    expect(defaultIdempotencyClassifier().classify("")).toBeNull()
    expect(defaultIdempotencyClassifier().classify("__proto__")).toBeNull()
  })

  test("HG-A5: DEFAULT_IDEMPOTENCY_TABLE explicit coverage (drift sentinel)", () => {
    // Every name listed in the spec is mapped, AND nothing is mapped to an
    // unknown tier. Drift: when a new tool is added, this list MUST grow.
    const expectedPure = [
      "read",
      "grep",
      "glob",
      "git_status",
      "git_diff",
      "git_log",
      "git_blame",
      "git_churn",
      "git_blame_heatmap",
      "git_upstream_check",
      "git_review_diff",
      "git_moved_code",
      "git_conflict_inspect",
      "file_tree_summary",
      "parse_test_failure",
      "test_runner",
      "diagnostics",
      "localize",
      "read_image",
      "read_image_url",
      "web_fetch",
      "csv_read",
      "ndjson_read",
      "yaml_read",
      "pdf_read",
      "xlsx_read",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_type_definition",
      "lsp_implementation",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_rename_preview",
      "lsp_code_action",
      "lsp_signature_help",
      "shadow_snapshots",
      "subagent_poll",
      "subagent_await",
      "budget_status",
      "coverage_check",
    ]
    const expectedMutRecov = [
      "edit",
      "write",
      "scripted_replace",
      "apply_patch",
      "git_commit",
      "git_branch_switch",
      "update_working_state",
      "request_user_input",
      "shadow_rewind",
      "shadow_restore_partial",
    ]
    const expectedMutExt = ["bash", "subagent_fork", "lsp_format", "lsp_rename_apply", "web_search"]
    for (const n of expectedPure) expect(DEFAULT_IDEMPOTENCY_TABLE[n]).toBe("pure")
    for (const n of expectedMutRecov)
      expect(DEFAULT_IDEMPOTENCY_TABLE[n]).toBe("mutating-recoverable")
    for (const n of expectedMutExt) expect(DEFAULT_IDEMPOTENCY_TABLE[n]).toBe("mutating-external")
    // No tier is anything other than the 3.
    for (const tier of Object.values(DEFAULT_IDEMPOTENCY_TABLE)) {
      expect(["pure", "mutating-recoverable", "mutating-external"]).toContain(tier)
    }
  })
})

/* ====================================================================== */
/* B. ToolCallRecord + JSONL store (8)                                     */
/* ====================================================================== */

describe("B. ToolCallRecord + JSONL store", () => {
  test("HG-B1: append + list roundtrip", async () => {
    const baseDir = join(tmpRoot, "b1")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    const rec = mkRecord({ toolUseId: "tu-1" })
    await store.append("bg-1", rec)
    const out = await store.list("bg-1")
    expect(out.length).toBe(1)
    expect(out[0]?.toolUseId).toBe("tu-1")
    expect(out[0]?.toolName).toBe("read")
    expect(out[0]?.tier).toBe("pure")
  })

  test("HG-B2: byToolUseId returns the specific record", async () => {
    const baseDir = join(tmpRoot, "b2")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    await store.append("bg-2", mkRecord({ toolUseId: "tu-a", toolName: "read" }))
    await store.append("bg-2", mkRecord({ toolUseId: "tu-b", toolName: "grep" }))
    await store.append("bg-2", mkRecord({ toolUseId: "tu-c", toolName: "glob" }))
    const found = await store.byToolUseId("bg-2", "tu-b")
    expect(found?.toolName).toBe("grep")
    expect(await store.byToolUseId("bg-2", "tu-missing")).toBeNull()
  })

  test("HG-B3: multi-handle isolation (per-handle file)", async () => {
    const baseDir = join(tmpRoot, "b3")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    await store.append("bg-h1", mkRecord({ toolUseId: "tu-h1", toolName: "read" }))
    await store.append("bg-h2", mkRecord({ toolUseId: "tu-h2", toolName: "grep" }))
    expect((await store.list("bg-h1")).length).toBe(1)
    expect((await store.list("bg-h2")).length).toBe(1)
    expect((await store.list("bg-h1"))[0]?.toolUseId).toBe("tu-h1")
    expect((await store.list("bg-h2"))[0]?.toolUseId).toBe("tu-h2")
  })

  test("HG-B4: empty / unknown handle → []", async () => {
    const baseDir = join(tmpRoot, "b4")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    expect(await store.list("bg-never")).toEqual([])
    expect(await store.byToolUseId("bg-never", "any")).toBeNull()
    expect(await store.clear("bg-never")).toBe(0)
  })

  test("HG-B5: argsHash stability — same args produce same hash", () => {
    const h1 = hashToolArgs({ a: 1, b: "two" })
    const h2 = hashToolArgs({ a: 1, b: "two" })
    expect(h1).toBe(h2)
    // distinct args ⇒ distinct hash
    expect(hashToolArgs({ a: 2 })).not.toBe(h1)
    // 16 hex chars
    expect(h1.length).toBe(16)
    expect(h1).toMatch(/^[0-9a-f]+$/)
  })

  test("HG-B6: sensitiveRedacted marker preserved", async () => {
    const baseDir = join(tmpRoot, "b6")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    await store.append("bg-6", mkRecord({ toolUseId: "tu-6", sensitiveRedacted: true }))
    const out = await store.list("bg-6")
    expect(out[0]?.sensitiveRedacted).toBe(true)
  })

  test("HG-B7: shadowCommit present for mutating tiers, absent for pure", async () => {
    const baseDir = join(tmpRoot, "b7")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    await store.append("bg-7", mkRecord({ toolUseId: "tu-pure", tier: "pure" }))
    await store.append(
      "bg-7",
      mkRecord({
        toolUseId: "tu-mut",
        toolName: "edit",
        tier: "mutating-recoverable",
        shadowCommit: "abc123def456",
      }),
    )
    const out = await store.list("bg-7")
    const pure = out.find((r) => r.toolUseId === "tu-pure")
    const mut = out.find((r) => r.toolUseId === "tu-mut")
    expect(pure?.shadowCommit).toBeUndefined()
    expect(mut?.shadowCommit).toBe("abc123def456")
  })

  test("HG-B8: crash safety — torn final line is silently skipped (bottom-up walker)", async () => {
    const baseDir = join(tmpRoot, "b8")
    const store = defaultJsonlToolHistoryStore({ baseDir })
    // Two clean appends.
    await store.append("bg-8", mkRecord({ toolUseId: "tu-1", toolName: "read" }))
    await store.append("bg-8", mkRecord({ toolUseId: "tu-2", toolName: "grep" }))
    // Simulate torn write: append a half-line (no newline, broken JSON).
    const { appendFile } = await import("node:fs/promises")
    const { createHash } = await import("node:crypto")
    const wsHash = createHash("sha256").update("/ws/R", "utf8").digest("hex").slice(0, 16)
    const target = join(baseDir, wsHash, "bg-8.tool-history.jsonl")
    await appendFile(target, '{"toolUseId":"tu-3","toolName":"glo')
    // Reader should return the 2 clean records and skip the torn line.
    const recs = await store.list("bg-8")
    expect(recs.length).toBe(2)
    expect(recs.map((r) => r.toolUseId)).toEqual(["tu-1", "tu-2"])
  })
})

/* ====================================================================== */
/* C. ToolReplayPolicy (8)                                                 */
/* ====================================================================== */

describe("C. ToolReplayPolicy", () => {
  const policy: ToolReplayPolicy = defaultToolReplayPolicy()
  const classifier = defaultIdempotencyClassifier()

  test("HG-C1: record + pure → replay-from-cache", () => {
    const r = mkRecord({ toolUseId: "tu", toolName: "read", tier: "pure" })
    const d = policy.decide(r, "read", classifier)
    expect(d.action).toBe("replay-from-cache")
    if (d.action === "replay-from-cache") expect(d.record.toolUseId).toBe("tu")
  })

  test("HG-C2: record + mutating-recoverable → replay-from-cache (orchestrator handles shadow restore)", () => {
    const r = mkRecord({
      toolUseId: "tu",
      toolName: "edit",
      tier: "mutating-recoverable",
      shadowCommit: "sha-abc",
    })
    const d = policy.decide(r, "edit", classifier)
    expect(d.action).toBe("replay-from-cache")
    if (d.action === "replay-from-cache") expect(d.record.shadowCommit).toBe("sha-abc")
  })

  test("HG-C3: record + mutating-external → replay-from-cache (output captured; do NOT re-run side effect)", () => {
    const r = mkRecord({
      toolUseId: "tu",
      toolName: "bash",
      tier: "mutating-external",
      result: { ok: true, output: "captured stdout" },
    })
    const d = policy.decide(r, "bash", classifier)
    expect(d.action).toBe("replay-from-cache")
    if (d.action === "replay-from-cache") expect(d.record.result.output).toBe("captured stdout")
  })

  test("HG-C4: no record + pure → safe-re-run", () => {
    const d = policy.decide(null, "read", classifier)
    expect(d.action).toBe("safe-re-run")
    if (d.action === "safe-re-run") expect(d.reason.toLowerCase()).toContain("pure")
  })

  test("HG-C5: no record + mutating-recoverable → halt", () => {
    const d = policy.decide(null, "edit", classifier)
    expect(d.action).toBe("halt")
    if (d.action === "halt") expect(d.reason.toLowerCase()).toContain("mutating-recoverable")
  })

  test("HG-C6: no record + mutating-external → ask-user-confirm", () => {
    const d = policy.decide(null, "bash", classifier)
    expect(d.action).toBe("ask-user-confirm")
    if (d.action === "ask-user-confirm") expect(d.reason.toLowerCase()).toContain("side effect")
  })

  test("HG-C7: unknown tier on record → halt (defensive)", () => {
    // Synthesize a record with a tier the policy does not recognize (bypass
    // type-check via cast — simulates a corrupted on-disk row).
    const r = mkRecord({ toolUseId: "tu", toolName: "weird", tier: "bogus" as never })
    const d = policy.decide(r, "weird", classifier)
    expect(d.action).toBe("halt")
    if (d.action === "halt") expect(d.reason.toLowerCase()).toContain("tier")
  })

  test("HG-C8: policy.decide is NO-THROW — internal errors collapse to halt", () => {
    // Pass a classifier that throws — policy MUST catch + collapse.
    const throwingClassifier: IdempotencyClassifier = {
      classify() {
        throw new Error("kaboom")
      },
    }
    const d = policy.decide(null, "anything", throwingClassifier)
    expect(d.action).toBe("halt")
    if (d.action === "halt") expect(d.reason.toLowerCase()).toContain("kaboom")
  })
})

/* ====================================================================== */
/* D. replayToolHistory orchestrator (5)                                   */
/* ====================================================================== */

describe("D. replayToolHistory", () => {
  test("HG-D1: 3 pure records → 3 replay-from-cache outcomes", async () => {
    const recs: ToolCallRecord[] = [
      mkRecord({ toolUseId: "tu-1", toolName: "read", tier: "pure" }),
      mkRecord({ toolUseId: "tu-2", toolName: "grep", tier: "pure" }),
      mkRecord({ toolUseId: "tu-3", toolName: "glob", tier: "pure" }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
    })
    expect(outcomes.length).toBe(3)
    for (const o of outcomes) expect(o.decision.action).toBe("replay-from-cache")
  })

  test("HG-D2: mutating-recoverable → shadowOdb.restoreToCommit called with shadowCommit", async () => {
    const calls: Array<{ ws: string; sha: string }> = []
    const restorer: ShadowCommitRestorer = {
      async restoreToCommit(ws, sha) {
        calls.push({ ws, sha })
      },
    }
    const recs: ToolCallRecord[] = [
      mkRecord({
        toolUseId: "tu-mut",
        toolName: "edit",
        tier: "mutating-recoverable",
        shadowCommit: "sha-mut-1",
      }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
      shadowOdb: restorer,
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.decision.action).toBe("replay-from-cache")
    expect(outcomes[0]?.restoredCommit).toBe("sha-mut-1")
    expect(calls.length).toBe(1)
    expect(calls[0]?.sha).toBe("sha-mut-1")
    expect(calls[0]?.ws).toBe("/ws/R")
  })

  test("HG-D3: no shadowOdb wired + mutating-recoverable → halt", async () => {
    const recs: ToolCallRecord[] = [
      mkRecord({
        toolUseId: "tu-mut",
        toolName: "edit",
        tier: "mutating-recoverable",
        shadowCommit: "sha-mut-2",
      }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
      // no shadowOdb
    })
    expect(outcomes[0]?.decision.action).toBe("halt")
    if (outcomes[0]?.decision.action === "halt") {
      expect(outcomes[0].decision.reason.toLowerCase()).toContain("shadow")
    }
  })

  test("HG-D4: mixed pure + mutating-recoverable + mutating-external in input order", async () => {
    const calls: string[] = []
    const restorer: ShadowCommitRestorer = {
      async restoreToCommit(_ws, sha) {
        calls.push(sha)
      },
    }
    const recs: ToolCallRecord[] = [
      mkRecord({ toolUseId: "tu-a", toolName: "read", tier: "pure" }),
      mkRecord({
        toolUseId: "tu-b",
        toolName: "write",
        tier: "mutating-recoverable",
        shadowCommit: "sha-b",
      }),
      mkRecord({
        toolUseId: "tu-c",
        toolName: "bash",
        tier: "mutating-external",
        result: { ok: true, output: "captured" },
      }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
      shadowOdb: restorer,
    })
    expect(outcomes.length).toBe(3)
    expect(outcomes.map((o) => o.toolUseId)).toEqual(["tu-a", "tu-b", "tu-c"])
    expect(outcomes.every((o) => o.decision.action === "replay-from-cache")).toBe(true)
    expect(outcomes[1]?.restoredCommit).toBe("sha-b")
    expect(calls).toEqual(["sha-b"])
  })

  test("HG-D5: workspace mismatch in record → halt (cross-workspace replay prevented)", async () => {
    const recs: ToolCallRecord[] = [
      mkRecord({
        toolUseId: "tu-cross",
        toolName: "read",
        tier: "pure",
        workspace: "/ws/OTHER",
      }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
    })
    expect(outcomes[0]?.decision.action).toBe("halt")
    if (outcomes[0]?.decision.action === "halt") {
      expect(outcomes[0].decision.reason).toContain("workspace")
    }
  })

  test("HG-D6: shadow restore throws → halt outcome with restoreError; iteration continues", async () => {
    const restorer: ShadowCommitRestorer = {
      async restoreToCommit() {
        throw new Error("git restore fail")
      },
    }
    const recs: ToolCallRecord[] = [
      mkRecord({
        toolUseId: "tu-throw",
        toolName: "edit",
        tier: "mutating-recoverable",
        shadowCommit: "sha-throw",
      }),
      mkRecord({ toolUseId: "tu-next", toolName: "read", tier: "pure" }),
    ]
    const outcomes = await replayToolHistory({
      records: recs,
      classifier: defaultIdempotencyClassifier(),
      policy: defaultToolReplayPolicy(),
      workspace: "/ws/R",
      shadowOdb: restorer,
    })
    expect(outcomes.length).toBe(2)
    expect(outcomes[0]?.decision.action).toBe("halt")
    expect(outcomes[0]?.restoreError).toContain("git restore fail")
    // Iteration continues — next record still gets processed.
    expect(outcomes[1]?.decision.action).toBe("replay-from-cache")
  })
})

/* ====================================================================== */
/* E. Resumer integration (4)                                              */
/* ====================================================================== */

describe("E. Resumer integration (resumeInterruptedHandles + toolReplay)", () => {
  test("HG-E1: resumer with toolHistoryStore wired → outcome includes toolReplays", async () => {
    const sched = fakeScheduler()
    const st = fakePersistenceStore()
    const th = memoryToolHistoryStore()
    th.seed("bg-E1", [
      mkRecord({ toolUseId: "tu-1", toolName: "read", tier: "pure" }),
      mkRecord({ toolUseId: "tu-2", toolName: "grep", tier: "pure" }),
    ])
    st.seed("/ws/R", [mkHandle({ id: "bg-E1" })])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
      toolReplay: { store: th.store },
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.toolReplays?.length).toBe(2)
    expect(outcomes[0]?.toolReplays?.[0]?.toolUseId).toBe("tu-1")
    expect(outcomes[0]?.toolReplays?.every((o) => o.decision.action === "replay-from-cache")).toBe(
      true,
    )
  })

  test("HG-E2: resumer WITHOUT toolHistoryStore → Phase 2.5 byte-identical (no toolReplays key)", async () => {
    const sched = fakeScheduler()
    const st = fakePersistenceStore()
    st.seed("/ws/R", [mkHandle({ id: "bg-E2" })])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
    })
    expect(outcomes.length).toBe(1)
    // exactOptional: NOT set to `undefined`, the key should be ABSENT.
    expect(outcomes[0]?.toolReplays).toBeUndefined()
    expect("toolReplays" in (outcomes[0] ?? {})).toBe(false)
  })

  test("HG-E3: chained resume — child B's tool history starts FRESH (not inherited from A)", async () => {
    // Document the policy: a re-fork starts fresh; the new handle has a new
    // id, and the tool-history store is keyed by handle id. So even if A had
    // records, B sees zero. Mirrors Codex's "function_call_output per
    // conversation" — outputs are bound to the original handle, not chained.
    const sched = fakeScheduler()
    const st = fakePersistenceStore()
    const th = memoryToolHistoryStore()
    th.seed("bg-A", [mkRecord({ toolUseId: "tu-A1", toolName: "read", tier: "pure" })])
    // Note: store has records ONLY for bg-A; bg-new-0001 (the resumed child) is
    // empty by construction.
    st.seed("/ws/R", [mkHandle({ id: "bg-A" })])
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
      toolReplay: { store: th.store },
    })
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]?.id).toBe("bg-A")
    expect(outcomes[0]?.newId).toBe("bg-new-0001")
    // A's history was replayed (1 outcome).
    expect(outcomes[0]?.toolReplays?.length).toBe(1)
    // The CHILD's id has NO seeded records — list returns [].
    expect(await th.store.list("bg-new-0001")).toEqual([])
  })

  test("HG-E4: tool replay failure (shadow restore throws) → halt outcomes; main resume STILL proceeds", async () => {
    const sched = fakeScheduler()
    const st = fakePersistenceStore()
    const th = memoryToolHistoryStore()
    th.seed("bg-E4", [
      mkRecord({
        toolUseId: "tu-throw",
        toolName: "edit",
        tier: "mutating-recoverable",
        shadowCommit: "sha-X",
      }),
    ])
    st.seed("/ws/R", [mkHandle({ id: "bg-E4" })])
    const throwingShadow: ShadowCommitRestorer = {
      async restoreToCommit() {
        throw new Error("shadow restore boom")
      },
    }
    const outcomes = await resumeInterruptedHandles({
      scheduler: sched.scheduler,
      store: st.store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      now: () => 99,
      toolReplay: { store: th.store, shadowOdb: throwingShadow },
    })
    expect(outcomes.length).toBe(1)
    // Halt outcome surfaces for the failing record.
    expect(outcomes[0]?.toolReplays?.[0]?.decision.action).toBe("halt")
    expect(outcomes[0]?.toolReplays?.[0]?.restoreError).toContain("shadow restore boom")
    // Main resume STILL proceeded — newId set, scheduler.fork was called.
    expect(outcomes[0]?.newId).toBe("bg-new-0001")
    expect(sched.forks.length).toBe(1)
  })
})
