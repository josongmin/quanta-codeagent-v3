/**
 * ADR-0512 P3 — the shared turn driver must forward an escalation approval's
 * once/session SCOPE + corrective STEER to `session.approval.respond`, and must
 * treat an ESCALATION deny as RECOVERABLE (the loop re-runs and the model gets a
 * `skill-scoped: declined`/`steered` tool_result) — NOT a turn-aborting throw.
 *
 * A NORMAL approval deny (no `scopeContext`) stays a hard abort (byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { driveSessionTurn as runSessionTurn } from "@/runner/orchestrate"
import type { PendingApprovalView } from "@/protocol/session"

type RespondArgs = {
  approvalId: string
  decision: "approve" | "deny"
  meta: unknown
}

/** Build a minimal RuntimeSession double that yields a scripted sequence of
 *  turn payloads (each either an approvalRequest or a terminal completion) and
 *  records every `approval.respond`. */
const makeSession = (turns: Array<{ approvalRequest?: PendingApprovalView }>) => {
  const responds: RespondArgs[] = []
  let i = 0
  const session = {
    input: { append: async () => {} },
    turn: {
      run: async () => {
        const turn = turns[i] ?? {}
        i += 1
        return {
          turn: {
            messages: [],
            outcome: { reason: "completed", turns: 1, messages: [] },
            ...(turn.approvalRequest !== undefined
              ? { approvalRequest: turn.approvalRequest }
              : {}),
          },
        }
      },
    },
    approval: {
      respond: async (approvalId: string, decision: "approve" | "deny", meta: unknown) => {
        responds.push({ approvalId, decision, meta })
      },
    },
  }
  return { session: session as never, responds }
}

const escalationApproval: PendingApprovalView = {
  approvalId: "esc-1",
  reason: "skill-scope escalation",
  requestedAt: "2026-06-09T00:00:00.000Z",
  scopeContext: { tool: "peek", activeSkill: "sealed", reason: "out of scope", risk: "read-only" },
}

const normalApproval: PendingApprovalView = {
  approvalId: "norm-1",
  reason: "write approval",
  requestedAt: "2026-06-09T00:00:00.000Z",
}

const run = (session: never, resolveApproval: never) =>
  runSessionTurn({
    session,
    resolveApproval,
    text: "go",
    turnSignal: new AbortController().signal,
  })

describe("turn driver — escalation approval scope/steer + recoverable deny", () => {
  test("escalation approve {scope:'once'} forwards scope to approval.respond", async () => {
    const { session, responds } = makeSession([{ approvalRequest: escalationApproval }, {}])
    await run(session, (async () => ({ decision: "approve", scope: "once" })) as never)
    expect(responds).toHaveLength(1)
    expect(responds[0]?.decision).toBe("approve")
    expect(responds[0]?.meta).toMatchObject({ scope: "once" })
  })

  test("escalation deny_and_steer forwards the steer AND does NOT throw (recoverable)", async () => {
    const { session, responds } = makeSession([{ approvalRequest: escalationApproval }, {}])
    await run(
      session,
      (async () => ({ decision: "deny", steer: "use grep instead" })) as never,
    )
    expect(responds[0]?.decision).toBe("deny")
    expect(responds[0]?.meta).toMatchObject({ steer: "use grep instead" })
  })

  test("escalation plain deny is RECOVERABLE — runSessionTurn resolves (no abort throw)", async () => {
    const { session } = makeSession([{ approvalRequest: escalationApproval }, {}])
    const result = await run(session, (async () => "deny") as never)
    expect(result.outcome.reason).toBe("completed")
  })

  test("NORMAL approval deny still ABORTS (throws) — byte-identical legacy", async () => {
    const { session } = makeSession([{ approvalRequest: normalApproval }, {}])
    let threw = false
    try {
      await run(session, (async () => "deny") as never)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("a plain string 'approve' resolver still works (back-compat, no scope)", async () => {
    const { session, responds } = makeSession([{ approvalRequest: escalationApproval }, {}])
    await run(session, (async () => "approve") as never)
    expect(responds[0]?.decision).toBe("approve")
  })
})
