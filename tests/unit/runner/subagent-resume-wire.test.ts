/**
 * Wiring test — QUANTA_SUBAGENT_RESUME gate in
 * buildSharedExecutionPlaneRuntimeAugments (GROUP B1).
 *
 * Verifies:
 *   A. Gate OFF (default): interrupted handle stays interrupted in store
 *      (normalizeBgStatus never writes back to store — store is ground truth).
 *   B. Gate ON: resumeInterruptedHandles is called, interrupted handle is
 *      written back to store as "resumed" before the function returns.
 *   C. Byte-identical: when subagentConfig is absent, function still returns
 *      without touching the store regardless of gate value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent/types"
import {
  defaultJsonlSchedulerStore,
  type PersistedHandle,
} from "@/agent/subagent-persistence-store"
import {
  buildSharedExecutionPlaneRuntimeAugments,
  type SharedExecutionPlaneRuntimeArgs,
} from "@/runner/session-execution-plane"
import { ToolRegistry } from "@/tool"

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build an interrupted handle.  `spec.metadata.idempotent` is set to "true"
 *  so `defaultResumePolicy` returns "resume" instead of "skip" (the default
 *  conservative policy skips handles without the opt-in marker — separate
 *  concern, covered by subagent-resume-hellgate.test.ts). */
const mkHandle = (id: string, over: Partial<PersistedHandle> = {}): PersistedHandle => ({
  id,
  spec: { task: `task-${id}`, metadata: { idempotent: "true" } },
  status: "interrupted",
  startedAt: Date.now() - 60_000,
  turns: 2,
  outputSummary: "(interrupted)",
  workspace: "/ws/test",
  ...over,
})

/** Structurally-valid but fully-inert AgentConfig. The subagent runner created
 *  from this config will never be invoked synchronously within the test window
 *  (any async background fork may fail, which is OK — the test only observes
 *  the store state, not the forked task result). */
// biome-ignore lint/suspicious/noExplicitAny: inert port stubs
const fakeParentConfig = (): AgentConfig =>
  ({
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "GO" }] }],
    system: "FAKE",
    cwd: "/ws/test",
    maxTurns: 5,
    signal: new AbortController().signal,
  }) as AgentConfig

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "quanta-resume-wire-"))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

// ─── A. Gate OFF (default) ──────────────────────────────────────────────────

describe("A. Gate OFF — store is untouched", () => {
  test("A1: interrupted handle stays interrupted when QUANTA_SUBAGENT_RESUME is absent", async () => {
    const store = defaultJsonlSchedulerStore({ baseDir })
    const handle = mkHandle("bg-test-a001")
    await store.save(handle)

    const args: SharedExecutionPlaneRuntimeArgs = {
      history: [],
      parentConfig: fakeParentConfig(),
      subagentConfig: { maxDepth: 3 },
      cwd: "/ws/test",
      envSource: { QUANTA_BG_STORE_DIR: baseDir },
    }
    await buildSharedExecutionPlaneRuntimeAugments(args)

    const after = await store.load("bg-test-a001")
    expect(after).not.toBeNull()
    expect(after?.status).toBe("interrupted")
  })

  test("A2: interrupted handle stays interrupted when QUANTA_SUBAGENT_RESUME=0", async () => {
    const store = defaultJsonlSchedulerStore({ baseDir })
    const handle = mkHandle("bg-test-a002")
    await store.save(handle)

    const args: SharedExecutionPlaneRuntimeArgs = {
      history: [],
      parentConfig: fakeParentConfig(),
      subagentConfig: { maxDepth: 3 },
      cwd: "/ws/test",
      envSource: { QUANTA_BG_STORE_DIR: baseDir, QUANTA_SUBAGENT_RESUME: "0" },
    }
    await buildSharedExecutionPlaneRuntimeAugments(args)

    const after = await store.load("bg-test-a002")
    expect(after).not.toBeNull()
    expect(after?.status).toBe("interrupted")
  })
})

// ─── B. Gate ON ─────────────────────────────────────────────────────────────

describe("B. Gate ON — interrupted handle becomes resumed", () => {
  test("B1: QUANTA_SUBAGENT_RESUME=1 causes interrupted handle to be marked resumed", async () => {
    const store = defaultJsonlSchedulerStore({ baseDir })
    // INV-09 LIVE: the plane wires a lineageGuard from the scheduler's
    // resume-fork depth (= parentDepth+1 = 0+1 = 1 for a root parent). A handle
    // persisted at the MATCHING depth resumes normally.
    const handle = mkHandle("bg-test-b001", { depth: 1 })
    await store.save(handle)

    const args: SharedExecutionPlaneRuntimeArgs = {
      history: [],
      parentConfig: fakeParentConfig(),
      subagentConfig: { maxDepth: 3 },
      cwd: "/ws/test",
      envSource: {
        QUANTA_BG_STORE_DIR: baseDir,
        QUANTA_SUBAGENT_RESUME: "1",
      },
    }
    await buildSharedExecutionPlaneRuntimeAugments(args)

    const after = await store.load("bg-test-b001")
    expect(after).not.toBeNull()
    // The orchestrator marks the original handle "resumed" and forks a new one.
    expect(after?.status).toBe("resumed")
  })

  test("B2: the resumed handle outputSummary references the new handle id", async () => {
    const store = defaultJsonlSchedulerStore({ baseDir })
    const handle = mkHandle("bg-test-b002", { depth: 1 })
    await store.save(handle)

    const args: SharedExecutionPlaneRuntimeArgs = {
      history: [],
      parentConfig: fakeParentConfig(),
      subagentConfig: { maxDepth: 3 },
      cwd: "/ws/test",
      envSource: {
        QUANTA_BG_STORE_DIR: baseDir,
        QUANTA_SUBAGENT_RESUME: "1",
      },
    }
    await buildSharedExecutionPlaneRuntimeAugments(args)

    const after = await store.load("bg-test-b002")
    expect(after?.outputSummary).toMatch(/^resumed as bg-/)
  })
})

// ─── C. Byte-identical when subagentConfig absent ───────────────────────────

describe("C. No subagentConfig — gate has no effect", () => {
  test("C1: interrupted handle untouched when subagentConfig is absent (gate=1)", async () => {
    const store = defaultJsonlSchedulerStore({ baseDir })
    const handle = mkHandle("bg-test-c001")
    await store.save(handle)

    const args: SharedExecutionPlaneRuntimeArgs = {
      history: [],
      parentConfig: fakeParentConfig(),
      // subagentConfig absent → execution plane returns early, never touches store
      cwd: "/ws/test",
      envSource: {
        QUANTA_BG_STORE_DIR: baseDir,
        QUANTA_SUBAGENT_RESUME: "1",
      },
    }
    await buildSharedExecutionPlaneRuntimeAugments(args)

    const after = await store.load("bg-test-c001")
    expect(after).not.toBeNull()
    // No subagentConfig → no persistent scheduler → no resume call → stays interrupted.
    expect(after?.status).toBe("interrupted")
  })
})
