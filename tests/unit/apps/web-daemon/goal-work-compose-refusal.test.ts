/**
 * GOAL-08 rail 15 (web half) — the LATE refusal contract of the composed
 * handler: the ack says "accepted" as soon as the pre-checks pass and the turn
 * is dispatched, but if that dispatch is then REFUSED (a stale objective
 * generation, a revision conflict, a claim refusal, a closed session) the
 * client MUST be told — the round-4 lesson: never accepted-then-silently-
 * dropped. `settled()` must also resolve for a rejected dispatch (a daemon
 * shutdown cannot hang on it).
 */

import { describe, expect, test } from "bun:test"
import { composeWebGoalWork } from "@/apps/web-daemon/goal-work-compose"
import {
  createObjectiveAttemptSlot,
  createObjectiveAuthority,
  createObjectiveCapabilities,
} from "@/objective"
import type { RuntimeSession } from "@/sdk/runtime"

/** The snapshot shape the compose pre-checks read (kernel `SessionSnapshotLite`). */
const snapshotOf = (
  over: Partial<{ status: string; draftInput: string; approval: unknown }> = {},
) => ({
  revision: 3,
  state: { status: over.status ?? "idle", draftInput: over.draftInput ?? "" },
  pendingApproval: over.approval ?? null,
})

const stubSession = (
  submit: () => Promise<never> | Promise<unknown>,
  snapshot: ReturnType<typeof snapshotOf> = snapshotOf(),
) =>
  ({
    sessionId: "t",
    snapshot: async () => snapshot,
    turn: { submitGoalWork: submit },
  }) as unknown as RuntimeSession

const composed = (
  submit: () => Promise<unknown>,
  opts: { snapshot?: ReturnType<typeof snapshotOf>; budget?: { maxTurns: number } } = {},
) => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  authority.create("t", {
    goal: "ship",
    successCriteria: ["c"],
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  })
  const handler = composeWebGoalWork({
    session: stubSession(submit, opts.snapshot),
    runtime: { objectiveAuthority: authority, objectiveAttemptSlot: createObjectiveAttemptSlot() },
  })
  if (handler === undefined) throw new Error("not composed")
  return { authority, handler }
}

describe("GOAL-08 rail 15 — web goal work late refusal", () => {
  test("a REFUSED dispatch is reported after the accept (two frames, the second names the reason)", async () => {
    const { handler } = composed(async () => {
      throw new Error("invalid_turn_submit_provenance")
    })
    const replies: unknown[] = []
    handler.request("fix the flake", (result) => replies.push(result))
    await handler.settled()
    expect(replies[0]).toEqual({ ok: true, status: "accepted" })
    expect(replies[1]).toMatchObject({ ok: false })
    expect(String((replies[1] as { reason: string }).reason)).toContain(
      "invalid_turn_submit_provenance",
    )
  })

  test("paired control: a dispatch that RESOLVES sends exactly one frame (the accept)", async () => {
    const { handler } = composed(async () => ({ revision: 4, seq: 1, events: [] }))
    const replies: unknown[] = []
    handler.request("fix the flake", (result) => replies.push(result))
    await handler.settled()
    expect(replies).toEqual([{ ok: true, status: "accepted" }])
  })

  test("settled() resolves even when every dispatch rejects (shutdown cannot hang)", async () => {
    const { handler } = composed(async () => {
      throw new Error("session_closed")
    })
    handler.request("a", () => undefined)
    handler.request("b", () => undefined)
    await expect(handler.settled()).resolves.toBeUndefined()
  })

  test("the objective generation is fenced at consume time: validateCurrent rejects a moved revision", async () => {
    let validate: (() => boolean) | undefined
    const { authority, handler } = composed(async (input?: unknown) => {
      validate = (input as { validateCurrent: () => boolean } | undefined)?.validateCurrent
      return { revision: 4, seq: 1, events: [] }
    })
    const objectiveId = authority.get("t")?.objectiveId ?? ""
    const revisionAtRequest = authority.readDomain("t").revision
    handler.request("fix the flake", () => undefined)
    await handler.settled()
    expect(validate?.()).toBe(true)
    // (a) SAME generation, moved revision — isolates the REVISION fence.
    authority.setNextActions?.("t", ["do the thing"])
    expect(authority.get("t")?.objectiveId).toBe(objectiveId)
    expect(authority.readDomain("t").revision).toBeGreaterThan(revisionAtRequest)
    expect(validate?.()).toBe(false)
    // (b) a NEW generation (clear + create) — also refused.
    authority.clear("t")
    authority.create("t", { goal: "ship v2", successCriteria: ["c"] })
    expect(validate?.()).toBe(false)
  })

  test("a BUSY session (running turn / unsent draft / pending approval) is refused BEFORE any dispatch", async () => {
    for (const [label, snapshot] of [
      ["running turn", snapshotOf({ status: "running" })],
      ["unsent draft", snapshotOf({ draftInput: "half typed" })],
      ["pending approval", snapshotOf({ approval: { approvalId: "a" } })],
    ] as const) {
      let dispatched = 0
      const { handler } = composed(
        async () => {
          dispatched += 1
          return {}
        },
        { snapshot },
      )
      const replies: unknown[] = []
      handler.request("fix the flake", (result) => replies.push(result))
      await handler.settled()
      expect({ label, replies, dispatched }).toEqual({
        label,
        replies: [
          {
            ok: false,
            reason: replies[0] === undefined ? "" : (replies[0] as { reason: string }).reason,
          },
        ],
        dispatched: 0,
      })
      expect(String((replies[0] as { reason: string }).reason).length).toBeGreaterThan(0)
    }
  })

  test("an EXHAUSTED turn budget is refused at request time (the authority would fail the turn AFTER the ack)", async () => {
    let dispatched = 0
    const { authority, handler } = composed(
      async () => {
        dispatched += 1
        return {}
      },
      { budget: { maxTurns: 1 } },
    )
    // Burn the single allowed turn through the REAL attempt lifecycle.
    const system = createObjectiveCapabilities(authority).system
    const domain = authority.readDomain("t")
    const objectiveId = domain.state?.objective.objectiveId ?? ""
    expect(
      system.commit("t", {
        kind: "beginAttempt",
        attempt: {
          objectiveId,
          attemptId: "a1",
          provenance: "user-requested-goal-work",
          executionMode: "foreground",
          startedRevision: domain.revision,
        },
      }).ok,
    ).toBe(true)
    expect(
      system.commit("t", {
        kind: "settleAttempt",
        settlement: {
          objectiveId,
          attemptId: "a1",
          startedRevision: domain.revision,
          tokensUsed: 1,
          turnsUsed: 0,
          outcome: "completed",
          executionMode: "foreground",
          criterionIdsBefore: [],
          verifierReceiptIdsBefore: [],
          recordedAt: 2,
        },
      }).ok,
    ).toBe(true)
    expect(authority.get("t")?.budget.turnsUsed).toBe(1)
    const replies: unknown[] = []
    handler.request("fix the flake", (result) => replies.push(result))
    await handler.settled()
    expect(dispatched).toBe(0)
    expect(replies).toHaveLength(1)
    expect(String((replies[0] as { reason: string }).reason)).toContain("budget is exhausted")
  })

  test("settled() is BOUNDED: a turn that never settles cannot wedge shutdown", async () => {
    const { handler } = composed(() => new Promise<never>(() => undefined))
    handler.request("never settles", () => undefined)
    const started = Date.now()
    await handler.settled(60)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
