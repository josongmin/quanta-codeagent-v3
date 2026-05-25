import { describe, expect, test } from "bun:test"
import {
  buildReactorWatchEnvelope,
  deliverReactorWatchEnvelope,
  encodeReactorWatchEnvelope,
  parseReactorWatchEnvelope,
} from "../../src/apps/cli/reactor-watch-bridge"
import { ExternalPromptQueue } from "../../src/apps/cli/repl/external-prompt-queue"
import { injectSimulatedTurn, REACTOR_ENV_FLAG, type ProactiveTrigger } from "../../src/reactor"

const fakeTrigger = (): ProactiveTrigger =>
  Object.freeze({
    reason: "ci_completion",
    evidence: Object.freeze({ kind: "url" as const, value: "https://gh.test/pr/7" }),
    simulatedMessage: "CI completed on PR 7",
    abortSignal: new AbortController().signal,
  })

describe("reactor watch bridge — live CLI ingress", () => {
  test("encode/parse round-trip preserves the wire shape", () => {
    const line = encodeReactorWatchEnvelope("session-a", fakeTrigger())
    const parsed = parseReactorWatchEnvelope(line.trim())

    expect(parsed).toEqual(buildReactorWatchEnvelope("session-a", fakeTrigger()))
  })

  test("deliver reconstructs a detached ProactiveTrigger for the host", async () => {
    let received: ProactiveTrigger | undefined
    await deliverReactorWatchEnvelope({
      raw: encodeReactorWatchEnvelope("session-a", fakeTrigger()),
      sessionId: "session-a",
      onTrigger: (trigger) => {
        received = trigger
      },
    })

    expect(received?.reason).toBe("ci_completion")
    expect(received?.evidence).toEqual({ kind: "url", value: "https://gh.test/pr/7" })
    expect(received?.simulatedMessage).toBe("CI completed on PR 7")
    expect(received?.abortSignal.aborted).toBe(false)
  })

  test("host-side injectSimulatedTurn appends the audit suffix before enqueue", async () => {
    const queue = new ExternalPromptQueue()
    let injected = false
    await deliverReactorWatchEnvelope({
      raw: encodeReactorWatchEnvelope("session-b", fakeTrigger()),
      sessionId: "session-b",
      onTrigger: async (trigger) => {
        const result = await injectSimulatedTurn({
          trigger,
          agentLoop: {
            enqueueUserMessage: async (message) => {
              queue.push(message)
            },
          },
          envPort: { get: (name) => (name === REACTOR_ENV_FLAG ? "1" : undefined) },
          clockPort: { now: () => 1_700_000_500_000 },
          lastUserInputAt: 0,
          lastTurnOutcome: "success",
        })
        injected = result.injected
      },
    })
    const queued = await queue.next()

    expect(injected).toBe(true)
    expect(queued).toBe(
      "CI completed on PR 7 [reason=ci_completion evidence=url=https://gh.test/pr/7]",
    )
  })

  test("quiet-window skip stays closed: trigger arrives but nothing is enqueued", async () => {
    const queue = new ExternalPromptQueue()
    let result: Awaited<ReturnType<typeof injectSimulatedTurn>> | undefined
    await deliverReactorWatchEnvelope({
      raw: encodeReactorWatchEnvelope("session-c", fakeTrigger()),
      sessionId: "session-c",
      onTrigger: async (trigger) => {
        result = await injectSimulatedTurn({
          trigger,
          agentLoop: {
            enqueueUserMessage: async (message) => {
              queue.push(message)
            },
          },
          envPort: { get: (name) => (name === REACTOR_ENV_FLAG ? "1" : undefined) },
          clockPort: { now: () => 1_700_000_500_000 },
          lastUserInputAt: 1_700_000_490_000,
          lastTurnOutcome: "success",
        })
      },
    })

    expect(result).toEqual({ injected: false, reason: "quiet-window" })
    expect(queue.size()).toBe(0)
  })
})
