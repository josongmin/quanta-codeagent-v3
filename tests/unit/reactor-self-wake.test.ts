/**
 * ADR-0132 Phase C — `injectSimulatedTurn` (self-wake) coverage.
 *
 * Three hard guards (env / quiet-window / prior-fail) plus the audit-suffix
 * invariant plus the event-emission contract. All closed-port: tests pass
 * fakes for `EnvPort` / `ClockPort` / `AgentLoopPort`, plus a recording
 * sink for `ReactorSelfWakeEvent`.
 *
 * Production code path is exercised end-to-end without touching `process.env`,
 * a real clock, or a real agent loop.
 */

import { describe, expect, test } from "bun:test"
import {
  buildSimulatedMessage,
  injectSimulatedTurn,
  QUIET_WINDOW_MS,
  REACTOR_ENV_FLAG,
} from "@/reactor/self-wake"
import type {
  AgentLoopPort,
  ClockPort,
  EnvPort,
  LastTurnOutcome,
  ProactiveTrigger,
  ReactorSelfWakeEvent,
  TriggerReason,
} from "@/reactor/types"

/** Stable clock fixture. */
const clockAt = (ms: number): ClockPort => ({ now: () => ms })

/** Env fixture: a map-backed `EnvPort`. */
const envOf = (vars: Readonly<Record<string, string>>): EnvPort => ({
  get: (name) => vars[name],
})

/** Build a recording AgentLoopPort that captures every enqueued message. */
interface RecordedEnqueue {
  readonly message: string
  readonly signal: AbortSignal | undefined
}
interface FakeAgentLoop {
  readonly port: AgentLoopPort
  readonly calls: ReadonlyArray<RecordedEnqueue>
}
const recordingAgentLoop = (opts?: { throwOnEnqueue?: Error }): FakeAgentLoop => {
  const calls: RecordedEnqueue[] = []
  const port: AgentLoopPort = {
    enqueueUserMessage: async (message, o) => {
      calls.push({ message, signal: o?.signal })
      if (opts?.throwOnEnqueue !== undefined) throw opts.throwOnEnqueue
    },
  }
  return { port, calls }
}

/** Build a trigger with sensible defaults so each test only overrides what it
 *  cares about. The abort controller is fresh per call so a test that aborts
 *  it does not leak across tests. */
const makeTrigger = (
  overrides?: Partial<{
    reason: TriggerReason
    evidence: ProactiveTrigger["evidence"]
    simulatedMessage: string
    abortSignal: AbortSignal
  }>,
): ProactiveTrigger => {
  const ctrl = new AbortController()
  return Object.freeze({
    reason: overrides?.reason ?? "ci_completion",
    evidence:
      overrides?.evidence ?? Object.freeze({ kind: "url" as const, value: "https://example/pr/1" }),
    simulatedMessage: overrides?.simulatedMessage ?? "CI on PR #1 finished",
    abortSignal: overrides?.abortSignal ?? ctrl.signal,
  })
}

/** Collect emitted events into an array for assertion. */
const recordingSink = (): {
  readonly sink: (e: ReactorSelfWakeEvent) => void
  readonly events: ReadonlyArray<ReactorSelfWakeEvent>
} => {
  const events: ReactorSelfWakeEvent[] = []
  return {
    sink: (e) => {
      events.push(e)
    },
    events,
  }
}

describe("ADR-0132 Phase C — env guard", () => {
  test("env flag unset ⇒ skipped:env-off, never touches agent loop", async () => {
    const loop = recordingAgentLoop()
    const { sink, events } = recordingSink()
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({}),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
      onEvent: sink,
    })
    expect(res).toEqual({ injected: false, reason: "env-off" })
    expect(loop.calls.length).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0]?.outcome).toBe("skipped")
    expect(events[0]?.reason).toBe("env-off")
  })

  test("env flag set to '0' ⇒ skipped:env-off (only literal '1' enables)", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "0" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
    })
    expect(res.injected).toBe(false)
    expect(res.reason).toBe("env-off")
    expect(loop.calls.length).toBe(0)
  })

  test("env flag set to 'true' ⇒ skipped:env-off (string '1' only)", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "true" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
    })
    expect(res.reason).toBe("env-off")
  })

  test("default-OFF: env-off path never reads the clock or the loop", async () => {
    let clockReads = 0
    let loopCalls = 0
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: {
        enqueueUserMessage: async () => {
          loopCalls++
        },
      },
      envPort: envOf({}),
      clockPort: {
        now: () => {
          clockReads++
          return 1
        },
      },
      lastUserInputAt: 0,
    })
    expect(res.reason).toBe("env-off")
    // The function MAY read the clock once (for the event timestamp) but MUST
    // NOT reach the loop. Both budgets matter; the loop budget is harder.
    expect(loopCalls).toBe(0)
    expect(clockReads).toBeLessThanOrEqual(1)
  })
})

describe("ADR-0132 Phase C — quiet-window guard", () => {
  test("user typed 1ms ago ⇒ skipped:quiet-window", async () => {
    const loop = recordingAgentLoop()
    const { sink, events } = recordingSink()
    const now = 10_000_000
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(now),
      lastUserInputAt: now - 1,
      onEvent: sink,
    })
    expect(res.reason).toBe("quiet-window")
    expect(loop.calls.length).toBe(0)
    expect(events[0]?.outcome).toBe("skipped")
    expect(events[0]?.reason).toBe("quiet-window")
  })

  test("exactly QUIET_WINDOW_MS-1 ago ⇒ still quiet-window (strict <)", async () => {
    const loop = recordingAgentLoop()
    const now = 10_000_000
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(now),
      lastUserInputAt: now - (QUIET_WINDOW_MS - 1),
    })
    expect(res.reason).toBe("quiet-window")
  })

  test("exactly QUIET_WINDOW_MS ago ⇒ injected (boundary inclusive)", async () => {
    const loop = recordingAgentLoop()
    const now = 10_000_000
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(now),
      lastUserInputAt: now - QUIET_WINDOW_MS,
    })
    expect(res.reason).toBe("injected")
    expect(loop.calls.length).toBe(1)
  })

  test("lastUserInputAt in the FUTURE (clock skew) ⇒ quiet-window (safe-default)", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(0),
      lastUserInputAt: 60_000, // 60s ahead of "now"
    })
    expect(res.reason).toBe("quiet-window")
  })
})

describe("ADR-0132 Phase C — prior-fail guard", () => {
  const now = 10_000_000

  const baseEnabledOpts = {
    agentLoop: recordingAgentLoop().port,
    envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
    clockPort: clockAt(now),
    lastUserInputAt: 0, // well past the quiet window
  } as const

  test("lastTurnOutcome='fail' ⇒ skipped:prior-fail", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      ...baseEnabledOpts,
      agentLoop: loop.port,
      trigger: makeTrigger(),
      lastTurnOutcome: "fail",
    })
    expect(res.reason).toBe("prior-fail")
    expect(loop.calls.length).toBe(0)
  })

  test("lastTurnOutcome='success' ⇒ injected", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      ...baseEnabledOpts,
      agentLoop: loop.port,
      trigger: makeTrigger(),
      lastTurnOutcome: "success",
    })
    expect(res.reason).toBe("injected")
    expect(loop.calls.length).toBe(1)
  })

  test("lastTurnOutcome='partial' ⇒ injected (only 'fail' blocks)", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      ...baseEnabledOpts,
      agentLoop: loop.port,
      trigger: makeTrigger(),
      lastTurnOutcome: "partial",
    })
    expect(res.reason).toBe("injected")
  })

  test("lastTurnOutcome='uncertain' ⇒ injected", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      ...baseEnabledOpts,
      agentLoop: loop.port,
      trigger: makeTrigger(),
      lastTurnOutcome: "uncertain",
    })
    expect(res.reason).toBe("injected")
  })

  test("lastTurnOutcome omitted ⇒ treated as success (caller opts INTO fail-protection)", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      ...baseEnabledOpts,
      agentLoop: loop.port,
      trigger: makeTrigger(),
    })
    expect(res.reason).toBe("injected")
  })
})

describe("ADR-0132 Phase C — simulated-message suffix invariant", () => {
  test("injected message ends with [reason=<r> evidence=<kind>=<value>]", async () => {
    const loop = recordingAgentLoop()
    const trigger = makeTrigger({
      reason: "pr_comment",
      evidence: Object.freeze({
        kind: "url" as const,
        value: "https://example/c/42",
      }),
      simulatedMessage: "New PR comment from @alice: lgtm",
    })
    await injectSimulatedTurn({
      trigger,
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
    })
    expect(loop.calls.length).toBe(1)
    const msg = loop.calls[0]?.message
    expect(msg).toBeDefined()
    expect(msg).toContain("New PR comment from @alice: lgtm")
    expect(msg).toContain("[reason=pr_comment evidence=url=https://example/c/42]")
    // The suffix is the LAST anchor — nothing after the closing bracket.
    expect(msg?.endsWith("]")).toBe(true)
  })

  test("buildSimulatedMessage works for every TriggerReason and every evidence kind", () => {
    const reasons: ReadonlyArray<TriggerReason> = [
      "ci_completion",
      "pr_comment",
      "build_completion",
      "diff_ready",
      "test_pass",
      "manual_resume",
    ]
    const kinds = ["url", "sha", "log_path"] as const
    for (const r of reasons) {
      for (const k of kinds) {
        const ctrl = new AbortController()
        const t: ProactiveTrigger = Object.freeze({
          reason: r,
          evidence: Object.freeze({ kind: k, value: `v-${r}-${k}` }),
          simulatedMessage: "body",
          abortSignal: ctrl.signal,
        })
        const s = buildSimulatedMessage(t)
        expect(s).toContain(`[reason=${r} evidence=${k}=v-${r}-${k}]`)
      }
    }
  })
})

describe("ADR-0132 Phase C — event emission contract", () => {
  test("onEvent fires exactly once on injected path", async () => {
    const loop = recordingAgentLoop()
    const { sink, events } = recordingSink()
    await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
      onEvent: sink,
    })
    expect(events.length).toBe(1)
    const ev = events[0]
    expect(ev).toBeDefined()
    if (ev === undefined) return
    expect(ev.outcome).toBe("injected")
    expect(ev.reason).toBe("ci_completion")
    expect(ev.trigger?.reason).toBe("ci_completion")
    expect(ev.trigger?.evidenceKind).toBe("url")
    expect(ev.trigger?.evidenceValue).toBe("https://example/pr/1")
    expect(ev.at).toBe(10_000_000)
  })

  test("onEvent absent ⇒ no throw on success path", async () => {
    const loop = recordingAgentLoop()
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
    })
    expect(res.reason).toBe("injected")
  })

  test("onEvent absent ⇒ no throw on any skip path", async () => {
    const cases: ReadonlyArray<{
      label: string
      envOff: boolean
      quiet: boolean
      outcome?: LastTurnOutcome
    }> = [
      { label: "env-off", envOff: true, quiet: false },
      { label: "quiet-window", envOff: false, quiet: true },
      { label: "prior-fail", envOff: false, quiet: false, outcome: "fail" },
    ]
    for (const c of cases) {
      const opts: Parameters<typeof injectSimulatedTurn>[0] = {
        trigger: makeTrigger(),
        agentLoop: recordingAgentLoop().port,
        envPort: envOf(c.envOff ? {} : { [REACTOR_ENV_FLAG]: "1" }),
        clockPort: clockAt(10_000_000),
        lastUserInputAt: c.quiet ? 10_000_000 - 1 : 0,
        ...(c.outcome !== undefined ? { lastTurnOutcome: c.outcome } : {}),
      }
      const res = await injectSimulatedTurn(opts)
      expect(res.injected).toBe(false)
    }
  })

  test("event.at uses the injected clock (no wall-clock leak)", async () => {
    const loop = recordingAgentLoop()
    const { sink, events } = recordingSink()
    // A clearly synthetic time so we can't be lucky-matching wall clock.
    const pinnedAt = 99
    await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(pinnedAt),
      lastUserInputAt: -1_000_000_000,
      onEvent: sink,
    })
    expect(events[0]?.at).toBe(pinnedAt)
  })
})

describe("ADR-0132 Phase C — abort propagation", () => {
  test("trigger abortSignal already aborted ⇒ no enqueue, no event", async () => {
    const loop = recordingAgentLoop()
    const { sink, events } = recordingSink()
    const ctrl = new AbortController()
    ctrl.abort()
    const trigger = makeTrigger({ abortSignal: ctrl.signal })
    const res = await injectSimulatedTurn({
      trigger,
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
      onEvent: sink,
    })
    expect(res.injected).toBe(false)
    expect(loop.calls.length).toBe(0)
    // Aborted path is upstream — we do NOT emit a skip event for it (the
    // trigger source already knows).
    expect(events.length).toBe(0)
  })

  test("trigger signal is forwarded into enqueueUserMessage", async () => {
    const loop = recordingAgentLoop()
    const ctrl = new AbortController()
    const trigger = makeTrigger({ abortSignal: ctrl.signal })
    await injectSimulatedTurn({
      trigger,
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(10_000_000),
      lastUserInputAt: 0,
    })
    expect(loop.calls[0]?.signal).toBe(ctrl.signal)
  })

  test("loop throw propagates (caller decides retry)", async () => {
    const boom = new Error("queue full")
    const loop = recordingAgentLoop({ throwOnEnqueue: boom })
    let caught: unknown
    try {
      await injectSimulatedTurn({
        trigger: makeTrigger(),
        agentLoop: loop.port,
        envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
        clockPort: clockAt(10_000_000),
        lastUserInputAt: 0,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(boom)
  })
})

describe("ADR-0132 Phase C — guard ordering", () => {
  test("env-off wins over quiet-window AND prior-fail (cheapest guard first)", async () => {
    // All three guards would fire; env-off must be reported.
    const loop = recordingAgentLoop()
    const now = 10_000_000
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({}),
      clockPort: clockAt(now),
      lastUserInputAt: now - 1, // quiet-window would fire
      lastTurnOutcome: "fail", // prior-fail would fire
    })
    expect(res.reason).toBe("env-off")
  })

  test("quiet-window wins over prior-fail (env on, both other guards fire)", async () => {
    const loop = recordingAgentLoop()
    const now = 10_000_000
    const res = await injectSimulatedTurn({
      trigger: makeTrigger(),
      agentLoop: loop.port,
      envPort: envOf({ [REACTOR_ENV_FLAG]: "1" }),
      clockPort: clockAt(now),
      lastUserInputAt: now - 1, // quiet-window
      lastTurnOutcome: "fail", // prior-fail
    })
    expect(res.reason).toBe("quiet-window")
  })
})
