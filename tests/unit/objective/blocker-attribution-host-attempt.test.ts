/**
 * GOAL P0-A hellgate — a model blocker OBSERVATION is attributed by the HOST to
 * the live attempt, never by the model to a value it picked.
 *
 * The shipped `objective_update` description promises the operator and the model
 * that a blocker needs "three distinct attempts". Two facts broke that promise:
 *
 *  1. The id came from the tool layer (`ctx.turnId ?? ctx.toolCallId`).
 *     `ctx.turnId` is declared for the checkpoint policy and is set by NOTHING in
 *     production, and `ctx.toolCallId` is set only when `onToolDiff` is wired
 *     (web canvas). So on every CLI surface the model's `addBlocker` was refused
 *     100% of the time — and refused with a message that claimed the thread had
 *     no objective, which is a lie about a live objective.
 *  2. Where `toolCallId` DID arrive, it changes per TOOL CALL, so three calls in
 *     one turn satisfied a threshold that is supposed to span three attempts.
 *
 * The attempt identity is domain state (`attempts.started.attemptId`, reserved by
 * `beginAttempt` before any paid call), so the AUTHORITY stamps it. That also
 * makes the value unforgeable: a model that wants to escalate itself to `blocked`
 * cannot do it by varying a string it controls.
 *
 * Paired control: three REAL attempts still promote exactly one blocker — the
 * hysteresis is preserved, not disabled.
 */

import { describe, expect, test } from "bun:test"
import {
  type CommitResult,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAttemptStart,
  type ObjectiveAuthority,
} from "@/objective"
import type { Tool, ToolContext } from "@/tool"
import { objectiveTools } from "@/tool/objective"

const setup = () => {
  const authority = createObjectiveAuthority({ now: () => 7 })
  authority.create("t", { goal: "ship it", successCriteria: ["c"] })
  const caps = createObjectiveCapabilities(authority)
  const objectiveId = () => authority.get("t")?.objectiveId ?? ""
  const begin = (attemptId: string): CommitResult => {
    const attempt: ObjectiveAttemptStart = {
      objectiveId: objectiveId(),
      attemptId,
      provenance: "user-requested-goal-work",
      executionMode: "foreground",
      startedRevision: authority.readDomain("t").revision,
    }
    return caps.system.commit("t", { kind: "beginAttempt", attempt })
  }
  const settle = (attemptId: string): CommitResult =>
    caps.system.commit("t", {
      kind: "settleAttempt",
      settlement: {
        objectiveId: objectiveId(),
        attemptId,
        startedRevision: authority.readDomain("t").revision,
        tokensUsed: 1,
        turnsUsed: 1,
        outcome: "completed",
        executionMode: "foreground",
        criterionIdsBefore: [],
        verifierReceiptIdsBefore: [],
        recordedAt: 8,
      },
    })
  return { authority, caps, begin, settle }
}

/** A model `addBlocker` for one stable dependency. `attemptId` is what the MODEL
 *  claims — the host must ignore it. */
const observe = (authority: ObjectiveAuthority, claimed?: string): CommitResult =>
  authority.commit(
    authority.prepare({
      threadId: "t",
      actor: "model",
      mutation: {
        kind: "addBlocker",
        reason: "deployment approval is pending",
        waitingOn: "user",
        target: { kind: "approval", ref: "approval:deploy" },
        ...(claimed === undefined ? {} : { attemptId: claimed }),
      },
    }),
    { admitted: true },
  )

const observations = (authority: ObjectiveAuthority) =>
  authority.get("t")?.blockerObservations ?? []

describe("GOAL P0-A — the host attributes a blocker observation to the live attempt", () => {
  test("a model that supplies NO attemptId is attributed to the started attempt", () => {
    const { authority, begin } = setup()
    expect(begin("attempt-1").ok).toBe(true)

    const res = observe(authority)

    expect(res.ok).toBe(true)
    expect(observations(authority)).toHaveLength(1)
    expect(observations(authority)[0]?.distinctAttemptIds).toEqual(["attempt-1"])
    expect(authority.get("t")?.status).toBe("active")
  })

  test("a model-chosen attemptId cannot manufacture three distinct attempts", () => {
    const { authority, begin } = setup()
    expect(begin("attempt-1").ok).toBe(true)

    observe(authority, "forged-1")
    observe(authority, "forged-2")
    observe(authority, "forged-3")

    expect(authority.get("t")?.status).toBe("active")
    expect(authority.get("t")?.blockers).toEqual([])
    expect(observations(authority)[0]?.distinctAttemptIds).toEqual(["attempt-1"])
  })

  test("PAIRED CONTROL — three real attempts still promote exactly one blocker", () => {
    const { authority, begin, settle } = setup()
    for (const id of ["a1", "a2", "a3"]) {
      expect(begin(id).ok).toBe(true)
      observe(authority, "ignored-by-the-host")
      expect(settle(id).ok).toBe(true)
    }
    expect(authority.get("t")?.status).toBe("blocked")
    expect(authority.get("t")?.blockers).toHaveLength(1)
    expect(observations(authority)).toEqual([])
  })

  test("outside any attempt the refusal names the missing attempt, not a missing objective", () => {
    const { authority } = setup()

    const res = observe(authority)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("attempt-missing")
    expect(authority.get("t")).not.toBeNull()
    expect(observations(authority)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WIRING PROOF — the real tool, over a ToolContext shaped like the CLI's
// (no `turnId`, no `toolCallId`). This is the surface that was 100% dead.
// ─────────────────────────────────────────────────────────────────────────────

const cliCtx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ownerId: "t",
})

const drain = async (tool: Tool, input: unknown, ctx: ToolContext) => {
  let last: { ok: boolean; output: string } | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  if (last === undefined) throw new Error("no terminal result")
  return last
}

const updateTool = (authority: ObjectiveAuthority): Tool => {
  const caps = createObjectiveCapabilities(authority)
  const tool = objectiveTools({ model: caps.model, read: caps.read }).find(
    (t) => t.name === "objective_update",
  )
  if (tool === undefined) throw new Error("objective_update not found")
  return tool
}

const ADD_BLOCKER_INPUT = {
  op: {
    kind: "addBlocker",
    reason: "deployment approval is pending",
    waiting_on: "user",
    dependency_target: { kind: "approval", ref: "approval:deploy" },
  },
}

describe("GOAL P0-A — the CLI tool surface is no longer dead", () => {
  test("objective_update addBlocker succeeds on a ctx with no turnId and no toolCallId", async () => {
    const { authority, begin } = setup()
    expect(begin("attempt-1").ok).toBe(true)

    const res = await drain(updateTool(authority), ADD_BLOCKER_INPUT, cliCtx())

    expect(res.ok).toBe(true)
    expect(observations(authority)[0]?.distinctAttemptIds).toEqual(["attempt-1"])
  })

  test("with no attempt in flight the tool does not tell the model the objective is missing", async () => {
    const { authority } = setup()

    const res = await drain(updateTool(authority), ADD_BLOCKER_INPUT, cliCtx())

    expect(res.ok).toBe(false)
    expect(res.output).not.toContain("no objective set for this thread")
    expect(res.output).toContain("attempt")
  })
})
