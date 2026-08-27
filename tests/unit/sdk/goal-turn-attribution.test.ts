/**
 * GOAL-08 — a goal turn is ATTRIBUTED on every surface: the host verb claims
 * the session host's attempt slot BEFORE dispatch (so the host turn-runner's
 * GOAL-04 beginAttempt runs and the budget / receipts / hard-cap counter
 * move), releases it when the dispatch is refused, and mints the provenance
 * kind (autonomous continuation vs user-requested goal work) that raw wire
 * clients can never self-assert.
 */

import { describe, expect, test } from "bun:test"
import type { SessionHost } from "@/kernel/session"
import type { ObjectiveAttemptContext } from "@/objective"
import { SessionProtocolValidationError } from "@/protocol/session"
import { createRuntime } from "@/sdk/runtime"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", transport: "websocket" })

const makeHost = (opts: { claim?: boolean; throwOnRun?: boolean } = {}) => {
  const claims: ObjectiveAttemptContext[] = []
  const prompts: string[] = []
  let released = 0
  const host: SessionHost = {
    describe: () => ({
      sessionId: "goal-attr",
      permissionMode: "default",
      capabilityManifest: manifest,
    }),
    runTurn: async ({ prompt }) => {
      prompts.push(prompt)
      if (opts.throwOnRun) throw new Error("host exploded")
      return {
        outcome: { reason: "completed", turns: 1, messages: [] },
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }
    },
    claimGoalAttempt: (attempt) => {
      claims.push(attempt)
      return opts.claim ?? true
    },
    releaseGoalAttempt: () => {
      released += 1
    },
    close: async () => undefined,
  }
  return { host, claims, prompts, released: () => released }
}

describe("GOAL-08 — goal turn attribution through the session host", () => {
  test("autonomous continuation: claim BEFORE runTurn with autonomous provenance bound to the consumed capability", async () => {
    const { host, claims, prompts } = makeHost()
    const runtime = await createRuntime({ host: { createSessionHost: async () => host } })
    const session = await runtime.createSession({})
    const revision = (await session.snapshot()).revision
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")
    await submit({
      text: "continue",
      expectedSessionRevision: revision,
      objectiveId: "obj-1",
      objectiveRevision: 3,
      validateCurrent: () => true,
    })
    expect(prompts).toEqual(["continue"])
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      threadId: session.sessionId,
      objectiveId: "obj-1",
      startedRevision: 3,
      provenance: "autonomous-continuation",
      executionMode: "background",
    })
    expect(claims[0]?.attemptId.length).toBeGreaterThan(0)
  })

  test("a refused claim rejects typed BEFORE any host work and never dispatches", async () => {
    const { host, prompts } = makeHost({ claim: false })
    const runtime = await createRuntime({ host: { createSessionHost: async () => host } })
    const session = await runtime.createSession({})
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")
    await expect(
      submit({
        text: "continue",
        expectedSessionRevision: (await session.snapshot()).revision,
        objectiveId: "obj-1",
        objectiveRevision: 1,
        validateCurrent: () => true,
      }),
    ).rejects.toThrow(/goal_attempt_claim_refused/)
    expect(prompts).toEqual([])
  })

  test("a dispatch the reducer refuses (stale revision) never claims at all", async () => {
    const { host, claims, released, prompts } = makeHost()
    const runtime = await createRuntime({ host: { createSessionHost: async () => host } })
    const session = await runtime.createSession({})
    const submit = session.turn.submitGoalContinuation
    if (submit === undefined) throw new Error("submitGoalContinuation missing")
    await expect(
      submit({
        text: "continue",
        expectedSessionRevision: 999, // stale ⇒ the kernel refuses before the turn
        objectiveId: "obj-1",
        objectiveRevision: 1,
        validateCurrent: () => true,
      }),
    ).rejects.toBeDefined()
    expect(prompts).toEqual([])
    expect(claims).toHaveLength(0)
    expect(released()).toBe(0)
  })

  test("rail 15 — submitGoalWork mints USER-REQUESTED provenance; a raw turn.submit cannot self-assert it", async () => {
    const { host, claims } = makeHost()
    const runtime = await createRuntime({ host: { createSessionHost: async () => host } })
    const session = await runtime.createSession({})
    const work = session.turn.submitGoalWork
    if (work === undefined) throw new Error("submitGoalWork missing")
    await work({
      text: "fix the flake",
      expectedSessionRevision: (await session.snapshot()).revision,
      objectiveId: "obj-1",
      objectiveRevision: 2,
      validateCurrent: () => true,
    })
    expect(claims[0]).toMatchObject({
      provenance: "user-requested-goal-work",
      objectiveId: "obj-1",
    })
    // raw wire command with a self-asserted provenance: no capability ⇒ refused
    await expect(
      session.dispatch({
        sessionId: session.sessionId,
        type: "turn.submit",
        commandId: "forged",
        issuedAt: new Date(0).toISOString(),
        text: "forged",
        expectedSessionRevision: (await session.snapshot()).revision,
        provenance: {
          kind: "user-requested-goal-work",
          objectiveId: "obj-1",
          objectiveRevision: 2,
          attemptId: "forged-attempt",
        },
      }),
    ).rejects.toBeInstanceOf(SessionProtocolValidationError)
  })
})
