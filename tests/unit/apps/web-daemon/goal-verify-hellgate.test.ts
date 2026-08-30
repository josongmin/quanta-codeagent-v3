import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { composeWebGoalVerify } from "@/apps/web-daemon/goal-verify-compose"
import { peekGoalVerify } from "@/apps/web-daemon/goal-verify-frame"
import type { WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WSData } from "@/apps/web-daemon/server/ws-data"
import { consumeGoalVerifyFrame } from "@/apps/web-daemon/server/ws-handlers"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveVerificationPort,
} from "@/objective"

const THREAD = "verify-thread"

const checkedAuthority = () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  createObjectiveCapabilities(authority).user.commit(THREAD, {
    kind: "create",
    definition: {
      goal: "ship",
      criteria: [
        {
          text: "tests pass",
          check: { kind: "command", argv: ["true"], timeoutMs: 1_000, successExitCodes: [0] },
        },
      ],
    },
  })
  return authority
}

describe("goalVerify frame", () => {
  test("accepts only correlated non-negative revision requests", () => {
    expect(
      peekGoalVerify(
        JSON.stringify({ kind: "goalVerify", requestId: "req-1", expectedObjectiveRevision: 4 }),
      ),
    ).toEqual({ requestId: "req-1", expectedObjectiveRevision: 4 })
    expect(
      peekGoalVerify(
        JSON.stringify({ kind: "goalVerify", requestId: "", expectedObjectiveRevision: 4 }),
      ),
    ).toBeNull()
    expect(
      peekGoalVerify(
        JSON.stringify({ kind: "goalVerify", requestId: "r", expectedObjectiveRevision: -1 }),
      ),
    ).toBeNull()
  })
})

describe("goalVerify coordinator", () => {
  test("stale revision is refused before verifier execution", () => {
    const authority = checkedAuthority()
    let calls = 0
    const verifier: ObjectiveVerificationPort = {
      verify: async () => {
        calls += 1
        return { kind: "verified", passed: 1, failed: 0, revision: 2 }
      },
      reconcile: async () => ({ kind: "fresh", verified: 0 }),
    }
    const handler = composeWebGoalVerify({
      threadId: THREAD,
      runtime: { objectiveAuthority: authority, objectiveVerifier: verifier },
    })
    const answers: unknown[] = []
    handler?.request(0, (answer) => answers.push(answer))
    expect(calls).toBe(0)
    expect(answers[0]).toMatchObject({
      status: "refused",
      outcome: { kind: "rejected", reason: "stale-revision:1" },
    })
  })

  test("only one verification runs; shutdown aborts and drains it", async () => {
    const authority = checkedAuthority()
    let signal: AbortSignal | undefined
    const verifier: ObjectiveVerificationPort = {
      verify: async (_threadId, _ids, receivedSignal) => {
        signal = receivedSignal
        await new Promise<void>((resolve) =>
          receivedSignal?.addEventListener("abort", () => resolve()),
        )
        return { kind: "cancelled" }
      },
      reconcile: async () => ({ kind: "fresh", verified: 0 }),
    }
    const handler = composeWebGoalVerify({
      threadId: THREAD,
      runtime: { objectiveAuthority: authority, objectiveVerifier: verifier },
    })
    const answers: unknown[] = []
    handler?.request(1, (answer) => answers.push(answer))
    handler?.request(1, (answer) => answers.push(answer))
    expect(answers[0]).toMatchObject({
      status: "refused",
      outcome: { reason: "verification-in-flight" },
    })
    handler?.stop()
    await handler?.settled(100)
    expect(signal?.aborted).toBe(true)
    expect(answers).toContainEqual({ status: "completed", outcome: { kind: "cancelled" } })
  })

  test("preserves verifier outcomes instead of flattening operational failures", async () => {
    const authority = checkedAuthority()
    const verifier: ObjectiveVerificationPort = {
      verify: async () => ({ kind: "runner-unavailable", reason: "sandbox missing" }),
      reconcile: async () => ({ kind: "fresh", verified: 0 }),
    }
    const handler = composeWebGoalVerify({
      threadId: THREAD,
      runtime: { objectiveAuthority: authority, objectiveVerifier: verifier },
    })
    const answers: unknown[] = []

    handler?.request(1, (answer) => answers.push(answer))
    await handler?.settled(100)

    expect(answers).toEqual([
      {
        status: "completed",
        outcome: { kind: "runner-unavailable", reason: "sandbox missing" },
      },
    ])
  })
})

describe("goalVerify server boundary", () => {
  const socket = (registered = true) => {
    const sent: Record<string, unknown>[] = []
    return {
      ws: {
        data: { registered },
        send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      } as unknown as ServerWebSocket<WSData>,
      sent,
    }
  }

  test("not-composed and malformed owned frames are answered, never dropped", () => {
    const missing = socket()
    expect(
      consumeGoalVerifyFrame(
        missing.ws,
        {} as Pick<WebDaemonServerConfig, "goalVerify">,
        JSON.stringify({ kind: "goalVerify", requestId: "r", expectedObjectiveRevision: 1 }),
      ),
    ).toBe(true)
    expect(missing.sent[0]).toMatchObject({
      kind: "goalVerifyResult",
      requestId: "r",
      status: "refused",
      outcome: { reason: "verifier-unavailable" },
    })

    const malformed = socket()
    consumeGoalVerifyFrame(
      malformed.ws,
      {} as Pick<WebDaemonServerConfig, "goalVerify">,
      JSON.stringify({ kind: "goalVerify", requestId: "r" }),
    )
    expect(malformed.sent[0]).toMatchObject({ outcome: { reason: "malformed-request" } })
  })

  test("pre-registration request is refused before handler invocation", () => {
    let calls = 0
    const unready = socket(false)
    consumeGoalVerifyFrame(
      unready.ws,
      {
        goalVerify: {
          request: () => {
            calls += 1
          },
          stop: () => undefined,
          settled: async () => undefined,
        },
      },
      JSON.stringify({ kind: "goalVerify", requestId: "r", expectedObjectiveRevision: 1 }),
    )
    expect(calls).toBe(0)
    expect(unready.sent[0]).toMatchObject({ outcome: { reason: "session-not-ready" } })
  })
})
