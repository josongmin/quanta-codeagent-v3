import { describe, expect, test } from "bun:test"
import { composeWebGoalWake } from "@/apps/web-daemon/goal-wake-compose"
import type { SessionHost } from "@/kernel/session"
import { createObjectiveStore } from "@/objective"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { capabilitiesFor } from "../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", transport: "websocket" })

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("goal web submit daemon integration", () => {
  test("a concurrent user append cannot mix into the autonomous goal turn", async () => {
    const hostStarted = deferred<string>()
    const releaseHost = deferred<void>()
    const prompts: string[] = []
    const claims: { provenance: string; objectiveId: string }[] = []
    const host: SessionHost = {
      describe: () => ({
        sessionId: "goal-web-e2e",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({ prompt }) => {
        prompts.push(prompt)
        hostStarted.resolve(prompt)
        await releaseHost.promise
        return {
          outcome: { reason: "completed", turns: 1, messages: [] },
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }] },
            { role: "assistant", content: [{ type: "text", text: "checkpoint" }] },
          ],
        }
      },
      claimGoalAttempt: (attempt) => {
        claims.push(attempt)
        return true
      },
      close: async () => undefined,
    }
    const runtime = await createRuntime({
      host: { createSessionHost: async () => host },
    })
    const session: RuntimeSession = await runtime.createSession({})
    const objective = createObjectiveStore()
    objective.create(session.sessionId, {
      goal: "finish the daemon goal",
      successCriteria: ["daemon goal done"],
    })
    let timerCallback: (() => void) | undefined
    const wake = await composeWebGoalWake({
      session,
      runtime: { objectiveAuthority: objective },
      env: { QUANTA_GOAL_ENFORCE: "1" },
      setTimeoutFn: (fn) => {
        timerCallback = fn
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {
        timerCallback = undefined
      },
    })

    timerCallback?.()
    const autonomousPrompt = await hostStarted.promise
    const userAppend = session.input.append("independent user input", undefined, { enqueue: true })
    releaseHost.resolve()
    await userAppend

    expect(prompts).toEqual([autonomousPrompt])
    // GOAL-08 — the autonomous submit is ATTRIBUTED: the host's attempt slot was
    // claimed with autonomous provenance before the turn ran.
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      provenance: "autonomous-continuation",
      objectiveId: objective.get(session.sessionId)?.objectiveId ?? "",
    })
    expect(autonomousPrompt).toContain("finish the daemon goal")
    expect(autonomousPrompt).not.toContain("independent user input")
    expect((await session.snapshot()).state.draftInput).toBe("independent user input")

    wake?.stop()
    await session.close()
    await runtime.close()
  })
})
