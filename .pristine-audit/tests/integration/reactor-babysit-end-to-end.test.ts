/**
 * ADR-0132 Phase D — Reactor + babysit end-to-end integration.
 *
 * Composes the three reactor slices the production wiring will compose:
 *
 *   1. `createCiTriggerSource` (fake `GhCliPort`) — emits a CI completion.
 *   2. `injectSimulatedTurn` (fake `AgentLoopPort`) — performs the self-wake.
 *   3. The babysit skill descriptor — referenced via `BABYSIT_SKILL_NAME` to
 *      assert the skill name an integrator wires `manual_resume` through.
 *
 * The intent is to catch a contract break BETWEEN the slices that no single
 * unit test would notice: a renamed `TriggerReason`, a dropped audit suffix,
 * a missing skill descriptor, an env-flag typo. Each test holds ONE wiring
 * invariant in place.
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_TRIGGER_REASONS,
  createCiTriggerSource,
  createInMemorySeenRuns,
  type GhCliPort,
  injectSimulatedTurn,
  type ProactiveTrigger,
  REACTOR_ENV_FLAG,
  type ReactorSelfWakeEvent,
} from "@/reactor"
import { BABYSIT_SKILL_NAME, triggerBabysit } from "@/skill/system-skills/babysit"

const json = (v: unknown) => ({
  stdout: JSON.stringify(v),
  stderr: "",
  exitCode: 0 as const,
})

/** Build a `GhCliPort` that emits ONE completed CI run then nothing. */
const oneCompletedRunGh = (): GhCliPort => ({
  run: async (args) => {
    if (args[0] === "pr" && args[1] === "checks") {
      return json([
        {
          name: "unit",
          status: "COMPLETED",
          conclusion: "FAILURE",
          link: "https://gh.test/runs/100",
        },
      ])
    }
    if (args[0] === "pr" && args[1] === "view") {
      return json({
        url: "https://gh.test/owner/repo/pull/9",
        number: 9,
      })
    }
    return { stdout: "", stderr: "no match", exitCode: 1 }
  },
})

describe("ADR-0132 Phase D — CI trigger ⇒ self-wake ⇒ agent loop receives suffixed message", () => {
  test("CI completion drives an enqueued user message with [reason=ci_completion …] suffix", async () => {
    const ci = createCiTriggerSource({
      ghCliPort: oneCompletedRunGh(),
      clockPort: { now: () => 1_700_000_000_000 },
      repoCwd: "/tmp/repo",
      prRef: "9",
      seenRunsStore: createInMemorySeenRuns(),
    })

    // Poll the trigger source. One CI completion ⇒ one ProactiveTrigger.
    const triggers = await ci.poll()
    expect(triggers.length).toBe(1)
    const t = triggers[0]
    if (t === undefined) throw new Error("unreachable")
    expect(t.reason).toBe("ci_completion")

    // Wire the self-wake: env ON, well past the quiet window, success outcome.
    const enqueued: string[] = []
    const events: ReactorSelfWakeEvent[] = []
    const res = await injectSimulatedTurn({
      trigger: t,
      agentLoop: {
        enqueueUserMessage: async (m) => {
          enqueued.push(m)
        },
      },
      envPort: { get: (n) => (n === REACTOR_ENV_FLAG ? "1" : undefined) },
      clockPort: { now: () => 1_700_000_500_000 },
      lastUserInputAt: 0,
      lastTurnOutcome: "success",
      onEvent: (e) => events.push(e),
    })

    expect(res.injected).toBe(true)
    expect(enqueued.length).toBe(1)
    const msg = enqueued[0]
    expect(msg).toBeDefined()
    expect(msg).toContain("CI completed on PR 9")
    expect(msg).toContain("[reason=ci_completion evidence=url=https://gh.test/owner/repo/pull/9]")
    expect(events.length).toBe(1)
    expect(events[0]?.outcome).toBe("injected")
  })

  test("env-OFF default: NO message is enqueued even when a trigger fires", async () => {
    const ci = createCiTriggerSource({
      ghCliPort: oneCompletedRunGh(),
      clockPort: { now: () => 1_700_000_000_000 },
      repoCwd: "/tmp/repo",
      prRef: "9",
      seenRunsStore: createInMemorySeenRuns(),
    })
    const triggers = await ci.poll()
    expect(triggers.length).toBe(1)
    const t = triggers[0]
    if (t === undefined) throw new Error("unreachable")

    const enqueued: string[] = []
    const res = await injectSimulatedTurn({
      trigger: t,
      agentLoop: {
        enqueueUserMessage: async (m) => {
          enqueued.push(m)
        },
      },
      // No env var ⇒ guard 1 fires.
      envPort: { get: () => undefined },
      clockPort: { now: () => 1_700_000_500_000 },
      lastUserInputAt: 0,
      lastTurnOutcome: "success",
    })

    expect(res.injected).toBe(false)
    expect(res.reason).toBe("env-off")
    expect(enqueued.length).toBe(0)
  })

  test("user abort BEFORE poll ⇒ no triggers, no enqueue", async () => {
    const ci = createCiTriggerSource({
      ghCliPort: oneCompletedRunGh(),
      clockPort: { now: () => 1_700_000_000_000 },
      repoCwd: "/tmp/repo",
      prRef: "9",
    })
    const ctrl = new AbortController()
    ctrl.abort()
    const triggers = await ci.poll({ signal: ctrl.signal })
    expect(triggers).toEqual([])
  })

  test("user abort AFTER trigger but BEFORE inject ⇒ reason=aborted, no enqueue, no event", async () => {
    const ci = createCiTriggerSource({
      ghCliPort: oneCompletedRunGh(),
      clockPort: { now: () => 1_700_000_000_000 },
      repoCwd: "/tmp/repo",
      prRef: "9",
      seenRunsStore: createInMemorySeenRuns(),
    })
    const triggers = await ci.poll()
    expect(triggers.length).toBe(1)
    const t = triggers[0]
    if (t === undefined) throw new Error("unreachable")

    // Build a NEW trigger with an already-aborted signal, preserving the rest
    // of the shape. We must not mutate `t` (it's frozen).
    const ctrl = new AbortController()
    ctrl.abort()
    const abortedTrigger: ProactiveTrigger = Object.freeze({
      ...t,
      abortSignal: ctrl.signal,
    })

    const enqueued: string[] = []
    const events: ReactorSelfWakeEvent[] = []
    const res = await injectSimulatedTurn({
      trigger: abortedTrigger,
      agentLoop: {
        enqueueUserMessage: async (m) => {
          enqueued.push(m)
        },
      },
      envPort: { get: () => "1" },
      clockPort: { now: () => 1_700_000_500_000 },
      lastUserInputAt: 0,
      lastTurnOutcome: "success",
      onEvent: (e) => events.push(e),
    })
    expect(res.injected).toBe(false)
    expect(res.reason).toBe("aborted")
    expect(enqueued.length).toBe(0)
    expect(events.length).toBe(0)
  })

  test("manual /babysit path: skill name is reachable AND is a TriggerReason member", () => {
    // The babysit skill is the manual fallback for the same loop.
    expect(BABYSIT_SKILL_NAME).toBe("babysit")
    expect(triggerBabysit()).toEqual({ name: "babysit" })
    // `manual_resume` is the union member babysit's slash command maps to.
    expect(ALL_TRIGGER_REASONS).toContain("manual_resume")
  })
})
