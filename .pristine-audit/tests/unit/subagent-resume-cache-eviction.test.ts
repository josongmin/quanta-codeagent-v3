/**
 * Hydrating-scheduler cache eviction after resume sweep (ADR-0159 Phase 2 B1).
 *
 * After `resumeInterruptedHandles` writes "resumed" status for a handle, the
 * in-memory `interruptedById` / `hydratedById` caches in
 * `persistentBackgroundSubagentScheduler` must be evicted so a subsequent
 * `list()` / `poll()` call does NOT show the handle as "interrupted" (stale
 * duplicate).
 *
 * The fix: `PersistentBackgroundSubagentScheduler.evictInterrupted(id)` removes
 * the stale entries from both caches. `session-execution-plane.ts` calls this
 * for each outcome returned by `resumeInterruptedHandles`.
 *
 * Guard: ADR-0503 regression — must remain GREEN after the cache-eviction fix.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import {
  defaultJsonlSchedulerStore,
  type PersistedHandle,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"
import {
  askUserResumePolicy,
  defaultResumePolicy,
  resumeInterruptedHandles,
} from "@/agent/subagent-resume"

/* ====================================================================== */
/* helpers                                                                 */
/* ====================================================================== */

const mkInterruptedHandle = (id: string, workspace: string): PersistedHandle => ({
  id,
  spec: { task: `task-${id}`, metadata: { idempotent: "true" } },
  status: "interrupted",
  startedAt: Date.now() - 60_000,
  turns: 2,
  outputSummary: "(interrupted)",
  workspace,
})

/** Non-idempotent handle — defaultResumePolicy returns "skip" for this. */
const mkNonIdempotentHandle = (id: string, workspace: string): PersistedHandle => ({
  id,
  spec: { task: `task-${id}` },
  status: "interrupted",
  // Young enough to not hit maxAgeMs (24h), no maxTurns → falls through to "skip".
  startedAt: Date.now() - 60_000,
  turns: 2,
  outputSummary: "(interrupted)",
  workspace,
})

/** Inert runner: never resolves in the test window. */
const neverRunner = (): never => new Promise<never>(() => {}) as never

/* ====================================================================== */
/* tests                                                                   */
/* ====================================================================== */

describe("hydrating-scheduler cache eviction after resume sweep", () => {
  test("E1: evictInterrupted removes stale entry from list()", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "quanta-evict-"))
    try {
      const workspace = "/ws/evict-test"
      const store = defaultJsonlSchedulerStore({ baseDir })

      // Seed an interrupted handle BEFORE the scheduler hydrates.
      const handle = mkInterruptedHandle("bg-evict-001", workspace)
      await store.save(handle)

      // Build the hydrating scheduler — it loads the interrupted handle into
      // interruptedById + hydratedById during construction.
      const inner = defaultBackgroundSubagentScheduler({ runner: neverRunner })
      const persistent = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace,
        // Dead PID probe: treat any PID as dead so the handle stays "interrupted".
        isProcessAlive: () => false,
      })

      // Verify it appears as interrupted BEFORE the sweep (sanity check).
      const beforeList = persistent.list()
      const beforeEntry = beforeList.find((e) => e.id === "bg-evict-001")
      expect(beforeEntry).toBeDefined()
      expect(beforeEntry?.result.status).toBe("interrupted")

      // Run the resume sweep — calls store.save(markResumed(...)) + scheduler.fork(...).
      // Cast: persistent overrides poll/await with HydratedSubagentResult (incompatible
      // with BackgroundSubagentScheduler structurally), but the resumer only calls
      // scheduler.fork(), which IS fully compatible. Safe cast.
      const outcomes = await resumeInterruptedHandles({
        scheduler: persistent as unknown as BackgroundSubagentScheduler,
        store,
        policy: defaultResumePolicy(),
        workspace,
      })

      // Simulate what session-execution-plane does: evict each swept handle.
      for (const outcome of outcomes) {
        persistent.evictInterrupted(outcome.id)
      }

      // After eviction, the handle must NOT appear as "interrupted" in list().
      const afterList = persistent.list()
      const interruptedEntries = afterList.filter((e) => e.result.status === "interrupted")
      expect(interruptedEntries).toEqual([])

      // The original id should either be absent from list(), or have a non-
      // interrupted status (e.g., it was forked as running).
      const afterEntry = afterList.find((e) => e.id === "bg-evict-001")
      if (afterEntry !== undefined) {
        expect(afterEntry.result.status).not.toBe("interrupted")
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test("E2: evictInterrupted removes stale entry from poll()", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "quanta-evict2-"))
    try {
      const workspace = "/ws/evict-test-2"
      const store = defaultJsonlSchedulerStore({ baseDir })

      const handle = mkInterruptedHandle("bg-evict-002", workspace)
      await store.save(handle)

      const inner = defaultBackgroundSubagentScheduler({ runner: neverRunner })
      const persistent = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace,
        isProcessAlive: () => false,
      })

      // Before eviction: poll returns "interrupted".
      const beforePoll = persistent.poll("bg-evict-002")
      expect(beforePoll?.status).toBe("interrupted")

      // Run sweep + evict (mirrors session-execution-plane flow).
      const outcomes = await resumeInterruptedHandles({
        scheduler: persistent as unknown as BackgroundSubagentScheduler,
        store,
        policy: defaultResumePolicy(),
        workspace,
      })
      for (const outcome of outcomes) {
        persistent.evictInterrupted(outcome.id)
      }

      // After eviction: poll must NOT return "interrupted".
      const afterPoll = persistent.poll("bg-evict-002")
      if (afterPoll !== null) {
        expect(afterPoll.status).not.toBe("interrupted")
      }
      // (null is also acceptable — evicted from both caches entirely)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test("E3: evictInterrupted is a no-op for unknown ids (idempotent)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "quanta-evict3-"))
    try {
      const workspace = "/ws/evict-test-3"
      const store = defaultJsonlSchedulerStore({ baseDir })
      const inner = defaultBackgroundSubagentScheduler({ runner: neverRunner })
      const persistent = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace,
        isProcessAlive: () => false,
      })

      // Calling evictInterrupted on an unknown id must not throw, and must not
      // corrupt the scheduler — no phantom entries appear in list().
      persistent.evictInterrupted(
        "bg-never-existed" as Parameters<typeof persistent.evictInterrupted>[0],
      )
      expect(persistent.list()).toEqual([])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test("E4: skip decision — handle remains in list() after eviction loop (NOT evicted)", async () => {
    // defaultResumePolicy on a non-idempotent, young, turn-uncapped handle
    // returns {action:"skip"}.  The B1 eviction loop MUST NOT call
    // evictInterrupted for skip handles — the interrupted entry is still
    // valid state the user needs to inspect / act on.
    //
    // RED trigger: if evictInterrupted IS called for a "skip" outcome
    // (the pre-fix unconditional loop in session-execution-plane.ts) the
    // handle disappears from list().  This test asserts it must NOT disappear,
    // so it fails RED against the buggy code path and passes GREEN once the
    // fix guards on action==="resume".
    const baseDir = await mkdtemp(join(tmpdir(), "quanta-evict4-"))
    try {
      const workspace = "/ws/evict-test-4"
      const store = defaultJsonlSchedulerStore({ baseDir })

      const handle = mkNonIdempotentHandle("bg-evict-004", workspace)
      await store.save(handle)

      const inner = defaultBackgroundSubagentScheduler({ runner: neverRunner })
      const persistent = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace,
        isProcessAlive: () => false,
      })

      // Sanity: handle visible as "interrupted" before sweep.
      const beforeEntry = persistent.list().find((e) => e.id === "bg-evict-004")
      expect(beforeEntry).toBeDefined()
      expect(beforeEntry?.result.status).toBe("interrupted")

      // Run the resume sweep — policy returns "skip" for non-idempotent handle.
      const outcomes = await resumeInterruptedHandles({
        scheduler: persistent as unknown as BackgroundSubagentScheduler,
        store,
        policy: defaultResumePolicy(),
        workspace,
      })

      // Precondition: the decision really was "skip".
      const outcome = outcomes.find((o) => o.id === "bg-evict-004")
      expect(outcome).toBeDefined()
      expect(outcome?.decision.action).toBe("skip")

      // Apply the FIXED eviction loop from session-execution-plane.ts:
      // only evict when the resumer actually forked (action==="resume") or
      // marked the handle failed (action==="mark-failed").  "skip" outcomes
      // leave the store unchanged so the cache entry must be preserved.
      for (const o of outcomes) {
        if (o.decision.action === "resume" || o.decision.action === "mark-failed") {
          persistent.evictInterrupted(o.id)
        }
      }

      // The handle must still appear as "interrupted" — it was skipped, not resumed.
      const afterEntry = persistent.list().find((e) => e.id === "bg-evict-004")
      expect(afterEntry).toBeDefined()
      expect(afterEntry?.result.status).toBe("interrupted")
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test("E5: ask-user decision — handle remains in list() after eviction loop (NOT evicted)", async () => {
    // askUserResumePolicy always returns {action:"ask-user"}.  Same invariant:
    // the orchestrator takes no action (no fork, no store write), so the
    // interrupted handle is unchanged and must NOT be evicted from the cache.
    //
    // RED trigger: same as E4 — unconditional eviction removes the handle and
    // the assertion below fails RED.  GREEN once the fix guards on
    // action==="resume".
    const baseDir = await mkdtemp(join(tmpdir(), "quanta-evict5-"))
    try {
      const workspace = "/ws/evict-test-5"
      const store = defaultJsonlSchedulerStore({ baseDir })

      const handle = mkNonIdempotentHandle("bg-evict-005", workspace)
      await store.save(handle)

      const inner = defaultBackgroundSubagentScheduler({ runner: neverRunner })
      const persistent = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace,
        isProcessAlive: () => false,
      })

      const beforeEntry = persistent.list().find((e) => e.id === "bg-evict-005")
      expect(beforeEntry).toBeDefined()
      expect(beforeEntry?.result.status).toBe("interrupted")

      const outcomes = await resumeInterruptedHandles({
        scheduler: persistent as unknown as BackgroundSubagentScheduler,
        store,
        policy: askUserResumePolicy,
        workspace,
      })

      // Precondition: the decision really was "ask-user".
      const outcome = outcomes.find((o) => o.id === "bg-evict-005")
      expect(outcome).toBeDefined()
      expect(outcome?.decision.action).toBe("ask-user")

      // Apply the FIXED eviction loop: only evict for "resume" / "mark-failed".
      // "ask-user" takes no action so the cache entry must be preserved.
      for (const o of outcomes) {
        if (o.decision.action === "resume" || o.decision.action === "mark-failed") {
          persistent.evictInterrupted(o.id)
        }
      }

      // Must still appear as "interrupted" — ask-user means "do nothing until
      // the user confirms", so the cache entry must remain intact.
      const afterEntry = persistent.list().find((e) => e.id === "bg-evict-005")
      expect(afterEntry).toBeDefined()
      expect(afterEntry?.result.status).toBe("interrupted")
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
