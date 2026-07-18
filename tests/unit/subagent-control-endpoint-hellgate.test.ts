/**
 * Hellgate — RFC jul-18 §4.2 (WS2): the sanctioned per-child control endpoint.
 *
 * Migrates the wake-only `TurnWakeRegistry` into a typed control surface: each
 * running child registers ONE {@link SubagentControlEndpoint} under its
 * `req.taskId` exposing ONLY typed commands (wake/interrupt/steer) — never a
 * mutable `ActiveTurnState`, `ConversationActionSurface`, or `AbortController`
 * handle. This battery proves:
 *
 *   - the endpoint leaks NO mutable controller handle (typed commands only);
 *   - the disposer removes the endpoint AND its mailbox label together;
 *   - a STALE disposer cannot remove a REPLACEMENT endpoint for the same id
 *     (last-writer-safe);
 *   - STEER capability OFF keeps the prior followup child config shape (RFC §9 —
 *     no conversation-action port / activeTurnRef threaded to the child config;
 *     the wake/interrupt endpoint is still registered) — asserted via the runner
 *     wiring, both with followup fully off AND followup-on-steer-off;
 *   - bounded `submitSteer()` admission returns `queue_full` at capacity and
 *     NEVER grows unbounded / silently drops;
 *   - `interrupt()` maps gate state to the closed InterruptControlOutcome:
 *     idle→`woke_idle`, busy→`interrupted_active`, second→`already_interrupted`,
 *     unarmed→`not_armed`.
 *
 * PURE units against the endpoint factory + registry; runner wiring uses a fake
 * `runAgent` so no real LLM is needed.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  createChildControlEndpoint,
  createChildControlSurface,
} from "@/agent/subagent-control-endpoint"
import { makeSteerRetentionStore } from "@/agent/subagent-delivery"
import type { PeerEnvelope, SubagentSteerSubmission } from "@/agent/subagent-delivery/ports"
import { createSubagentRunner } from "@/agent/subagent-runner"
import { makeTurnHeader } from "@/agent/turn-kind"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"
import type { SubagentRequest } from "@/subagent"
import { SubagentTurnGate, TurnWakeRegistry } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── shared doubles ──────────────────────────────────────────────────────────

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

class OneShotLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const env = (from: string, body: string): PeerEnvelope => ({ from, formattedBody: body })

const submission = (
  deliveryId: string,
  expectedTurnId: string,
  body = "hi",
): SubagentSteerSubmission => ({
  deliveryId,
  envelope: env("root", body),
  expectedTurnId,
})

type TurnRef = NonNullable<AgentConfig["activeTurnRef"]>

/** A live active-turn ref parked on a steerable `main` turn with id `turnId`. */
const activeRef = (turnId: string): TurnRef => ({
  current: {
    currentTurn: makeTurnHeader({ turnId, kind: "main", startedAt: 0, threadId: "thread" }),
    isInterrupted: false,
  },
})

// ─── 1. typed commands only — no mutable controller handle leaks ──────────────

describe("SubagentControlEndpoint — typed commands only", () => {
  test("the endpoint exposes wake/interrupt/steer and NO ActiveTurnState / AbortController leak", () => {
    const gate = new SubagentTurnGate()
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 4 })
    const endpoint = createChildControlEndpoint({
      gate,
      surface,
      activeTurnRef: activeRef("t1"),
      mailboxLabel: "root/0",
      wake: (r) => gate.wake(r),
    })
    expect(typeof endpoint.wake).toBe("function")
    expect(typeof endpoint.interrupt).toBe("function")
    expect(typeof endpoint.steer).toBe("function")
    expect(endpoint.mailboxLabel).toBe("root/0")
    // No mutable handle escapes: the endpoint object owns none of these keys.
    const keys = Object.keys(endpoint)
    for (const banned of ["activeTurnRef", "gate", "surface", "controller", "turnAbort", "abort"]) {
      expect(keys).not.toContain(banned)
    }
    // Deep: no enumerable value on the endpoint is an AbortController or the ref.
    for (const v of Object.values(endpoint as unknown as Record<string, unknown>)) {
      expect(v instanceof AbortController).toBe(false)
      expect(v instanceof SubagentTurnGate).toBe(false)
    }
  })
})

// ─── 2. registry: endpointFor + disposal + last-writer-safe ──────────────────

const stubEndpoint = (label: string) => {
  const gate = new SubagentTurnGate()
  const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 4 })
  return createChildControlEndpoint({
    gate,
    surface,
    activeTurnRef: activeRef("t"),
    mailboxLabel: label,
    wake: (r) => gate.wake(r),
  })
}

describe("SubagentControlRegistry (TurnWakeRegistry superset) — endpoint lifecycle", () => {
  test("registered child is reachable via endpointFor with its mailbox label", () => {
    const reg = new TurnWakeRegistry()
    const ep = stubEndpoint("root/0")
    reg.registerEndpoint("task-A", ep)
    expect(reg.endpointFor("task-A")).toBe(ep)
    expect(reg.labelOf("task-A")).toBe("root/0")
  })

  test("disposer removes endpoint AND label together", () => {
    const reg = new TurnWakeRegistry()
    const ep = stubEndpoint("root/1")
    const dispose = reg.registerEndpoint("task-B", ep)
    expect(reg.endpointFor("task-B")).toBe(ep)
    expect(reg.labelOf("task-B")).toBe("root/1")
    dispose()
    expect(reg.endpointFor("task-B")).toBeUndefined()
    expect(reg.labelOf("task-B")).toBeUndefined()
  })

  test("a STALE disposer cannot remove a REPLACEMENT endpoint for the same task id", () => {
    const reg = new TurnWakeRegistry()
    const epA = stubEndpoint("root/A")
    const epB = stubEndpoint("root/B")
    const disposeA = reg.registerEndpoint("dup", epA)
    const disposeB = reg.registerEndpoint("dup", epB) // last-writer wins
    expect(reg.endpointFor("dup")).toBe(epB)
    disposeA() // stale — must NOT clobber epB
    expect(reg.endpointFor("dup")).toBe(epB)
    expect(reg.labelOf("dup")).toBe("root/B")
    disposeB()
    expect(reg.endpointFor("dup")).toBeUndefined()
  })

  test("legacy wake/labelOf still work for the current followup_task path (backward-compat)", () => {
    const reg = new TurnWakeRegistry()
    const gate = new SubagentTurnGate()
    const unreg = reg.register("legacy", (r) => gate.wake(r), "root/L")
    expect(reg.has("legacy")).toBe(true)
    expect(reg.labelOf("legacy")).toBe("root/L")
    // busy (not parked) ⇒ queued (byte-identical to the pre-WS2 contract)
    expect(reg.wake("legacy", "followup")).toBe("queued")
    unreg()
    expect(reg.wake("legacy", "followup")).toBe("no-receiver")
  })
})

// ─── 3. bounded submitSteer admission — queue_full, never unbounded ──────────

describe("createChildControlSurface.submitSteer — bounded FIFO admission", () => {
  test("admits up to capacity then returns queue_full; never grows past capacity", () => {
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 2 })
    const ref = activeRef("t1")
    expect(surface.submitSteer(submission("d1", "t1"), ref.current)).toBe("accepted")
    expect(surface.submitSteer(submission("d2", "t1"), ref.current)).toBe("accepted")
    expect(surface.pendingSteers()).toBe(2)
    // At capacity ⇒ queue_full, and the queue does NOT grow.
    expect(surface.submitSteer(submission("d3", "t1"), ref.current)).toBe("queue_full")
    expect(surface.pendingSteers()).toBe(2)
    expect(surface.submitSteer(submission("d4", "t1"), ref.current)).toBe("queue_full")
    expect(surface.pendingSteers()).toBe(2)
  })

  test("no active turn ⇒ no_active_turn (no admission)", () => {
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 2 })
    const idle = { currentTurn: null, isInterrupted: false }
    expect(surface.submitSteer(submission("d1", "t1"), idle)).toBe("no_active_turn")
    expect(surface.pendingSteers()).toBe(0)
  })

  test("expected-turn mismatch ⇒ turn_mismatch (never writes into a replacement turn)", () => {
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 2 })
    const ref = activeRef("t1")
    expect(surface.submitSteer(submission("d1", "OTHER"), ref.current)).toBe("turn_mismatch")
    expect(surface.pendingSteers()).toBe(0)
  })

  test("FIFO retention: each queued entry retains its deliveryId + immutable envelope", () => {
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 3 })
    const ref = activeRef("t1")
    surface.submitSteer(submission("d1", "t1", "first"), ref.current)
    surface.submitSteer(submission("d2", "t1", "second"), ref.current)
    const drained = surface.drainSteers()
    expect(drained.map((s) => s.deliveryId)).toEqual(["d1", "d2"]) // FIFO
    expect(drained[0]?.envelope.formattedBody).toBe("first")
    expect(surface.pendingSteers()).toBe(0) // drained
  })
})

// ─── 4. interrupt() closed outcome mapping from gate state ────────────────────

describe("SubagentControlEndpoint.interrupt — closed InterruptControlOutcome", () => {
  const mk = (gate: SubagentTurnGate) => {
    const surface = createChildControlSurface({ steerConfig: { maxInputBytes: 8192 }, capacity: 4 })
    return createChildControlEndpoint({
      gate,
      surface,
      activeTurnRef: activeRef("t1"),
      mailboxLabel: "root/0",
      wake: (r) => gate.wake(r),
    })
  }

  test("unarmed gate (no turn started) ⇒ not_armed", () => {
    const gate = new SubagentTurnGate()
    const ep = mk(gate)
    expect(ep.interrupt()).toBe("not_armed")
  })

  test("idle (parked) child ⇒ woke_idle", async () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    gate.armTurn(loop.signal)
    const waitP = gate.wait(loop.signal)
    await tick()
    expect(gate.isParked()).toBe(true)
    const ep = mk(gate)
    expect(ep.interrupt()).toBe("woke_idle")
    expect(await waitP).toBe("woke")
  })

  test("busy (mid-turn) child ⇒ interrupted_active; a second interrupt ⇒ already_interrupted", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    const turnSignal = gate.armTurn(loop.signal)
    const ep = mk(gate)
    expect(ep.interrupt()).toBe("interrupted_active")
    expect(turnSignal.aborted).toBe(true) // the in-flight turn actually aborted
    // Second interrupt on the same (still-aborting) turn ⇒ already_interrupted;
    // it must NOT double-abort / re-capture.
    expect(ep.interrupt()).toBe("already_interrupted")
  })
})

// ─── 5. runner wiring — default-OFF keeps the prior child config shape ───────

const parentCfg = (over: Partial<AgentConfig>, llm: LLMPort): AgentConfig =>
  ({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "sys",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as AgentConfig

const baseReq = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "child task",
  depth: 1,
  ...over,
})

describe("createSubagentRunner — control capability gating (default-OFF byte-identical)", () => {
  test("no wake registry ⇒ child config gets NO conversationActionPort / activeTurnRef", async () => {
    let seen: AgentConfig | undefined
    const run = (async (c: AgentConfig) => {
      seen = c
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(parentCfg({}, new OneShotLLM()), { run })
    await runner(baseReq({ taskId: "t1" }))
    expect(seen?.conversationActionPort).toBeUndefined()
    expect(seen?.activeTurnRef).toBeUndefined()
    expect(seen?.subagentTurnGate).toBeUndefined()
  })

  test("followup ON but steer OFF ⇒ NO conversationActionPort/activeTurnRef (RFC §9 byte-identity), but gate + endpoint registered", async () => {
    const wake = new TurnWakeRegistry()
    let seen: AgentConfig | undefined
    let endpointDuringRun: unknown
    const run = (async (c: AgentConfig) => {
      seen = c
      endpointDuringRun = wake.endpointFor("t1")
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(parentCfg({ subagentTurnWake: wake }, new OneShotLLM()), {
      run,
    })
    await runner(baseReq({ taskId: "t1" }))
    // MED-2 (hellaudit R1) — steer OFF ⇒ the child config is byte-identical to the
    // pre-jul-18 followup baseline: NO conversation-action port / active-turn ref
    // (the extra mid-turn drain must not exist). RFC §9.
    expect(seen?.conversationActionPort).toBeUndefined()
    expect(seen?.activeTurnRef).toBeUndefined()
    // But the wake/interrupt endpoint (gate-backed) IS registered for followup.
    expect(seen?.subagentTurnGate).toBeDefined()
    expect(endpointDuringRun).toBeDefined()
    expect((endpointDuringRun as { mailboxLabel: string }).mailboxLabel).toBe("root/0")
    // Disposed in finally ⇒ endpoint + legacy waker both gone.
    expect(wake.endpointFor("t1")).toBeUndefined()
    expect(wake.has("t1")).toBe(false)
    expect(wake.wake("t1", "followup")).toBe("no-receiver")
  })

  test("followup ON + steer ON (steer plane) ⇒ child config receives conversationActionPort + activeTurnRef (paired control)", async () => {
    const wake = new TurnWakeRegistry()
    const steerPlane = {
      retention: makeSteerRetentionStore(),
      finalization: {
        finalizeApplied: (): void => {},
        finalizeFallback: (): void => {},
        finalizeCancelled: (): void => {},
      },
    }
    let seen: AgentConfig | undefined
    const run = (async (c: AgentConfig) => {
      seen = c
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(
      parentCfg(
        {
          subagentTurnWake: wake,
          subagent: { steerPlane } as NonNullable<AgentConfig["subagent"]>,
        },
        new OneShotLLM(),
      ),
      { run },
    )
    await runner(baseReq({ taskId: "t1" }))
    // Steer ON ⇒ the loop-facing surface IS threaded (the safe-point drain needs it).
    expect(seen?.conversationActionPort).toBeDefined()
    expect(seen?.activeTurnRef).toBeDefined()
    expect(seen?.subagentTurnGate).toBeDefined()
  })
})

// ─── 6. HIGH-1 regression — omitted expectedTurnId (hellaudit R1) ──────────────
//
// `followup_task` has NO `expectedTurnId` schema field, so the controller submits
// an EMPTY id. Pre-fix this flowed into the steer authority's `assertRequestShape`,
// which THROWS `SteerInputInvalidError` on an empty id — crashing the entire
// `mode:"steer"` product path on its designed happy input. Every prior rail used a
// FAKE endpoint (`steer: () => "accepted"`) or an explicit non-empty id, so none
// exercised this real seam. These drive the REAL surface/endpoint.
describe("SubagentControlEndpoint — HIGH-1 regression (omitted expectedTurnId)", () => {
  const steerConfig = { maxInputBytes: 8192 }

  test("EMPTY expectedTurnId on a live steerable turn ⇒ accepted, NOT a throw", () => {
    const surface = createChildControlSurface({ steerConfig, capacity: 4 })
    const state = activeRef("turn-live").current
    expect(() => surface.submitSteer(submission("d1", ""), state)).not.toThrow()
    expect(surface.submitSteer(submission("d2", ""), state)).toBe("accepted")
    // The admitted submission carries the caller's (empty) id verbatim; resolution
    // happened for the steer-authority call only — the loop re-checks at drain.
    expect(surface.pendingSteers()).toBe(2)
  })

  test("EMPTY expectedTurnId with NO active turn ⇒ no_active_turn (still no throw)", () => {
    const surface = createChildControlSurface({ steerConfig, capacity: 4 })
    const idle = { currentTurn: null, isInterrupted: false }
    expect(surface.submitSteer(submission("d3", ""), idle)).toBe("no_active_turn")
    expect(surface.pendingSteers()).toBe(0)
  })

  test("endpoint.currentTurnId() reads the live turn id (the controller's resolution source)", () => {
    const gate = new SubagentTurnGate()
    const surface = createChildControlSurface({ steerConfig, capacity: 4 })
    const endpoint = createChildControlEndpoint({
      gate,
      surface,
      activeTurnRef: activeRef("turn-abc"),
      mailboxLabel: "root/0",
      wake: () => "woke",
    })
    expect(endpoint.currentTurnId()).toBe("turn-abc")
    // A non-empty explicit id is still honored verbatim (mismatch ⇒ turn_mismatch).
    expect(endpoint.steer(submission("d4", "turn-abc"))).toBe("accepted")
    expect(endpoint.steer(submission("d5", "other-turn"))).toBe("turn_mismatch")
  })
})
