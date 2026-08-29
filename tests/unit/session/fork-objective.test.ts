/**
 * GOAL-07 rail 12 — a fork is a PAUSED CLONE of the user declaration.
 *
 * Doc↔code audit (2026-08-30) found `cloneObjectiveForFork` shipped with ZERO
 * test references: the rail was recorded as covered by implementation alone.
 * This pins the contract on both persisted wire versions: the new generation
 * keeps only what the USER wrote (goal, criterion text, next actions, budget
 * CAPS) and starts evidence-free — new objectiveId, paused, no usage, no met
 * criteria, no verifier completion, no blockers, no attempt history.
 */

import { describe, expect, test } from "bun:test"
import { cloneObjectiveForFork } from "@/session/fork-objective"
import type { PersistedObjectiveSnapshot } from "@/session/types"

const v2 = (): PersistedObjectiveSnapshot =>
  ({
    version: 2,
    threads: [
      {
        threadId: "src-thread",
        revision: 9,
        objective: {
          objectiveId: "objective:src:1",
          createdBy: "user",
          goal: "ship the thing",
          successCriteria: [
            {
              id: "criterion:src:1",
              text: "tests pass",
              met: true,
              kind: "checked",
              check: { id: "check:src:1", kind: "command", argv: ["true"], timeoutMs: 1_000 },
              completion: {
                source: "verifier",
                checkId: "check:src:1",
                objectiveRevision: 9,
                verifierResult: { passed: true, exitCode: 0 },
              },
            },
          ],
          status: "completed",
          explicitStatus: "active",
          budget: { maxTokens: 500, tokensUsed: 480, maxTurns: 7, turnsUsed: 6 },
          blockers: [{ reason: "waiting on review", waitingOn: "human" }],
          nextActions: ["land it"],
          attempts: { autonomousTurnsStarted: 4 },
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ],
  }) as unknown as PersistedObjectiveSnapshot

describe("GOAL-07 rail 12 — fork clones the declaration and drops the evidence", () => {
  test("v2: new id, paused, zero usage, criteria reset, blockers/attempts cleared, caps kept", () => {
    const forked = cloneObjectiveForFork(v2(), "src-thread", "new-thread", 42)
    const thread = (
      forked as unknown as {
        threads: { threadId: string; revision: number; objective: Record<string, unknown> }[]
      }
    ).threads[0]
    expect(thread?.threadId).toBe("new-thread")
    expect(thread?.revision).toBe(1)
    const objective = thread?.objective as Record<string, unknown>
    // A NEW generation: the source id must not survive a fork.
    expect(objective.objectiveId).not.toBe("objective:src:1")
    expect(String(objective.objectiveId)).toContain("new-thread")
    expect(objective.createdBy).toBe("user")
    expect(objective.goal).toBe("ship the thing")
    // Paused, not "completed" — a fork never inherits a terminal verdict.
    expect(objective.status).toBe("paused")
    expect(objective.explicitStatus).toBe("paused")
    // Evidence-free.
    expect(objective.budget).toEqual({ maxTokens: 500, tokensUsed: 0, maxTurns: 7, turnsUsed: 0 })
    expect(objective.blockers).toEqual([])
    expect(objective.attempts).toEqual({ autonomousTurnsStarted: 0 })
    expect(objective.nextActions).toEqual(["land it"])
    const criteria = objective.successCriteria as Record<string, unknown>[]
    expect(criteria).toHaveLength(1)
    expect(criteria[0]?.text).toBe("tests pass")
    expect(criteria[0]?.met).toBe(false)
    expect(criteria[0]?.completion).toBeUndefined()
    // The check DECLARATION survives (it is user-authored) with a re-keyed id.
    expect((criteria[0]?.check as Record<string, unknown>)?.argv).toEqual(["true"])
    expect(String((criteria[0]?.check as Record<string, unknown>)?.id)).not.toBe("check:src:1")
    expect(String(criteria[0]?.id)).not.toBe("criterion:src:1")
  })

  test("v1 snapshots stay forkable with the same reset rules", () => {
    const snapshot = {
      version: 1,
      threads: [
        {
          threadId: "src-thread",
          revision: 4,
          goal: "legacy goal",
          successCriteria: [{ id: "c1", text: "done", met: true }],
          status: "active",
          explicitStatus: "active",
          budget: { maxTokens: 10, tokensUsed: 9, maxTurns: 2, turnsUsed: 2 },
          blockers: [{ reason: "x", waitingOn: "y" }],
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    } as unknown as PersistedObjectiveSnapshot
    const forked = cloneObjectiveForFork(snapshot, "src-thread", "fork-1", 7) as unknown as {
      version: number
      threads: Record<string, unknown>[]
    }
    expect(forked.version).toBe(1)
    const thread = forked.threads[0] as Record<string, unknown>
    expect(thread.status).toBe("paused")
    expect(thread.explicitStatus).toBe("paused")
    expect(thread.budget).toEqual({ maxTokens: 10, tokensUsed: 0, maxTurns: 2, turnsUsed: 0 })
    expect(thread.blockers).toEqual([])
    expect((thread.successCriteria as Record<string, unknown>[])[0]?.met).toBe(false)
  })

  test("a fork of an absent or unknown thread yields nothing to restore", () => {
    expect(cloneObjectiveForFork(undefined, "src-thread", "n", 1)).toBeUndefined()
    const twoThreads = {
      version: 2,
      threads: [
        { threadId: "a", revision: 1, objective: null },
        { threadId: "b", revision: 1, objective: null },
      ],
    } as unknown as PersistedObjectiveSnapshot
    expect(cloneObjectiveForFork(twoThreads, "missing", "n", 1)).toBeUndefined()
  })

  test("a cleared objective (tombstone) forks as a tombstone, not as a resurrected goal", () => {
    const tombstone = {
      version: 2,
      threads: [{ threadId: "only", revision: 3, objective: null }],
    } as unknown as PersistedObjectiveSnapshot
    const forked = cloneObjectiveForFork(tombstone, "only", "fork-2", 5) as unknown as {
      threads: { objective: unknown; revision: number }[]
    }
    expect(forked.threads[0]?.objective).toBeNull()
    expect(forked.threads[0]?.revision).toBe(1)
  })
})
