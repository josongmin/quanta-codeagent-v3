import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { runSessionLoop, type SessionLoopSinks } from "@/apps/cli/repl/session-loop"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import type { Message } from "@/llm"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import type { RuntimeContext } from "@/sdk/runtime"
import { makeSnapshotLite } from "../../../support/session-fixtures"
import { makeFakeRuntimeContext, makeFakeSessionSetup } from "./_cli-fakes"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const makeOutcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "needs approval" }] },
    { role: "assistant", content: [{ type: "text", text: "approved and completed" }] },
  ],
})

const buildSinks = (): SessionLoopSinks & {
  readonly events: string[]
  readonly errs: unknown[]
} => {
  const events: string[] = []
  const errs: unknown[] = []
  return {
    events,
    errs,
    renderTurnDashboard: () => events.push("dashboard"),
    renderAndResetSummary: () => events.push("summary"),
    flushLifecyclePills: () => events.push("pills"),
    renderTurnError: (err) => {
      events.push("error")
      errs.push(err)
    },
  }
}

const stubSetup = (approvalDecisions: readonly ApprovalDecisionResult[]) => {
  const counters = {
    approvalPrompt: 0,
    approvalRespond: 0,
    inputAppend: 0,
    turnRun: 0,
    sessionClose: 0,
    runtimeClose: 0,
  }
  // jun-10 — capture the respond WIRE (approvalId, decision, meta) so tests can
  // pin that a rich operator decision (e.g. the "[a]lways session" verb)
  // actually reaches `session.approval.respond` with its scope intact.
  const respondCalls: Array<{
    approvalId: string
    decision: string
    meta: { scope?: string; steer?: string } | undefined
  }> = []
  const queue = [...approvalDecisions]
  const outcome = makeOutcome()
  // Typed fake (audit R3 LOW-4): inert defaults from the builder; ONLY the
  // scripted facade is overridden here.
  const runtimeContext: RuntimeContext = makeFakeRuntimeContext({
    createRuntimeFacade: async () => ({
      createSession: async () => ({
        sessionId: "approval-flow-cli",
        dispatch: async () => ({ revision: 0, seq: 0, events: [] }),
        subscribe: () => () => undefined,
        snapshot: async () =>
          makeSnapshotLite({
            sessionId: "approval-flow-cli",
            revision: 0,
            seq: 0,
            state: { messageCount: outcome.messages.length },
            capabilities: { approvals: "operator", tools: true },
          }),
        attachSessionTransport: async () => ({ close: async () => undefined }),
        close: async () => {
          counters.sessionClose += 1
        },
        input: {
          append: async () => {
            counters.inputAppend += 1
            return { revision: 1, seq: 1, events: [] }
          },
        },
        turn: {
          run: async () => {
            counters.turnRun += 1
            if (counters.turnRun === 1) {
              return {
                revision: 2,
                seq: 2,
                events: [],
                turn: {
                  outcome,
                  messages: [],
                  approvalRequest: {
                    approvalId: "ap1",
                    reason: "terminal.needs_approval",
                    requestedAt: "2026-05-26T00:00:00.000Z",
                  },
                },
              }
            }
            return {
              revision: 4,
              seq: 4,
              events: [],
              turn: {
                outcome,
                messages: outcome.messages,
              },
            }
          },
          cancel: async () => ({ revision: 0, seq: 0, events: [] }),
        },
        identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        permission: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        approval: {
          respond: async (
            approvalId: string,
            decision: string,
            meta?: { scope?: string; steer?: string },
          ) => {
            counters.approvalRespond += 1
            respondCalls.push({ approvalId, decision, meta })
            return { revision: 3, seq: 3, events: [] }
          },
        },
        transcript: {
          replace: async (messages: readonly Message[]) => ({
            revision: 0,
            seq: 0,
            events: [],
            transcript: { messages: [...messages] },
          }),
          messages: () => [],
        },
        side: {
          start: async () => ({
            outcome,
            answerText: "",
            inputTokens: 0,
            outputTokens: 0,
            toolsAvailable: 0,
          }),
        },
      }),
      close: async () => {
        counters.runtimeClose += 1
      },
    }),
  })

  // Typed builder (audit R3 LOW-4): every default is a compile-checked fake;
  // only the slots THIS flow exercises are overridden. A future REQUIRED
  // `SessionSetupResult` field breaks the builder's compile, not this suite's
  // runtime.
  const setup: SessionSetupResult = makeFakeSessionSetup({
    cwd: "/tmp/test-cwd",
    sessionId: "approval-flow-cli",
    approvalPrompt: async () => {
      counters.approvalPrompt += 1
      const next = queue.shift()
      if (next === undefined) throw new Error("approval decision queue exhausted")
      return next
    },
    runtimeContext,
    argPrompt: "needs approval",
  })

  return { counters, setup, respondCalls }
}

describe("T5 approval flow cli", () => {
  test("CLI prompts, responds, and reruns the turn after approval", async () => {
    const { setup, counters } = stubSetup(["approve"])
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    expect(counters.inputAppend).toBe(1)
    expect(counters.turnRun).toBe(2)
    expect(counters.approvalPrompt).toBe(1)
    expect(counters.approvalRespond).toBe(1)
    expect(counters.sessionClose).toBe(1)
    expect(counters.runtimeClose).toBe(1)
    expect(sinks.events).toEqual(["dashboard", "summary", "pills"])
    expect(sinks.errs).toHaveLength(0)
  })

  test("CLI fails closed when the operator denies the pending approval", async () => {
    const { setup, counters } = stubSetup(["deny"])
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    expect(counters.inputAppend).toBe(1)
    expect(counters.turnRun).toBe(1)
    expect(counters.approvalPrompt).toBe(1)
    expect(counters.approvalRespond).toBe(1)
    expect(counters.sessionClose).toBe(1)
    expect(counters.runtimeClose).toBe(1)
    expect(sinks.events).toEqual(["error"])
    expect(sinks.errs).toHaveLength(1)
    expect(sinks.errs[0]).toBeInstanceOf(Error)
    expect((sinks.errs[0] as Error).message).toContain("runtime session approval denied")
  })

  test("a rich 'approve + scope:session' decision reaches approval.respond with scope INTACT (jun-10 'always' verb wire)", async () => {
    const { setup, counters, respondCalls } = stubSetup([{ decision: "approve", scope: "session" }])
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    // Same approve→rerun shape as the plain path…
    expect(counters.turnRun).toBe(2)
    expect(counters.approvalRespond).toBe(1)
    // …but the WIRE carries the session scope — this is what lets the runtime
    // controller mint the standing grant (one round-trip per key per session).
    expect(respondCalls).toEqual([
      { approvalId: "ap1", decision: "approve", meta: { scope: "session" } },
    ])
    expect(sinks.errs).toHaveLength(0)
  })

  test("CLI source routes approval requests through approval.respond and rerun", () => {
    const sessionLoop = read("src/apps/cli/repl/session-loop.ts")
    const sdkTypes = read("src/sdk/runtime/types.ts")
    // ADR-0303 — the approval-resolution loop was hoisted OUT of the surface
    // into the shared runner-owned driver. The CLI now ROUTES through it: each
    // turn funnels through `driveSessionTurn`, handing its operator resolver
    // (`setup.approvalPrompt`) in. The actual `approval.respond` + deny-throw
    // live in the driver — assert there, not in the surface.
    const driver = read("src/runner/orchestrate/session-turn-driver.ts")

    expect(sessionLoop).toContain("driveSessionTurn")
    expect(sessionLoop).toContain("setup.approvalPrompt")
    expect(driver).toContain("session.approval.respond")
    // ADR-0512 P3 — the deny-throw is now escalation-AWARE: a NORMAL approval
    // deny still aborts the turn, but an ESCALATION deny (the approval carries
    // `scopeContext`) is recoverable (the loop re-runs into a `skill-scoped`
    // decline), so the throw is gated on `scopeContext === undefined`.
    expect(driver).toContain('norm.decision === "deny" && approval.scopeContext === undefined')
    expect(sdkTypes).toContain("readonly approval:")
    expect(sdkTypes).toContain('decision: "approve" | "deny"')
  })
})
