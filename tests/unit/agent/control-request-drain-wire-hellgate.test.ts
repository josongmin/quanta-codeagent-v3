/**
 * Hellgate — control-request drain WIRE activation (ADR-0496, jul-03 A1).
 *
 * `drainControlRequests`/`applyControlEffect` existed as a fully-tested pure
 * surface with ZERO loop callers (inert). This pins the NET-NEW loop edge that
 * activates it: `pollControlRequests` (sibling of `pollPeerInbox`/
 * `pollFollowUpQueue`) drains the wired port at the turn-top seam, and
 * `syncQueuedTurnInputs` reaches it.
 *
 * Invariants proven (red-on-injection):
 *   1. WIRING — `syncQueuedTurnInputs` invokes the control-request drain: a
 *      pending `set_model` request reaches `applier.setModel` (proves the edge
 *      is not gated off to death / dead-code).
 *   2. DEFAULT-OFF — gate unset ⇒ the port is NEVER polled (byte-identical).
 *   3. GATE-OFF with slot present ⇒ still never polled (gate is load-bearing).
 *   4. NO-THROW — a throwing port/applier does not escape the turn seam.
 */
import { describe, expect, test } from "bun:test"
import type {
  ControlEffectApplier,
  ControlRequest,
  ControlRequestContext,
  ControlRequestPort,
} from "@/agent/control-request"
import { pollControlRequests } from "@/agent/loop/control-poll"
import { syncQueuedTurnInputs } from "@/agent/loop/turn-iteration"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"

const noopStream = { emit: () => {} }

// A port that counts every `.next()` call so we can prove default-OFF never polls.
const countingPort = (): { port: ControlRequestPort; polls: () => number } => {
  let polls = 0
  return {
    port: {
      next: () => {
        polls++
        return null
      },
    },
    polls: () => polls,
  }
}

/** Port that hands back each request once then null (bounded, non-hostile). */
const queuePort = (reqs: ControlRequest[]): ControlRequestPort => {
  const queue = [...reqs]
  return { next: () => queue.shift() ?? null }
}

const buildCfg = (controlRequest?: AgentConfig["controlRequest"]): AgentConfig =>
  ({
    stream: noopStream,
    ...(controlRequest !== undefined ? { controlRequest } : {}),
  }) as unknown as AgentConfig

const fakeWm = () => {
  const buf: Message[] = []
  return {
    messages: buf,
    append: (m: Message) => buf.push(m),
    snapshot: () => buf,
    clear: () => {
      buf.length = 0
    },
    replace: (xs: Message[]) => {
      buf.length = 0
      buf.push(...xs)
    },
    tokenEstimate: () => 0,
  }
}

describe("control-request drain — WIRE activation", () => {
  test("WIRING: syncQueuedTurnInputs drains the port ⇒ set_model reaches the applier", async () => {
    const models: string[] = []
    const applier: ControlEffectApplier = { setModel: (m) => models.push(m) }
    const ctx: ControlRequestContext = { modelAllowlist: ["gpt-x", "gpt-y"] }
    const req: ControlRequest = { kind: "set_model", model: "gpt-y" }
    const cfg = buildCfg({
      port: queuePort([req]),
      applier,
      context: ctx,
      env: { QUANTA_CONTROL_REQUEST: "1" },
    })
    const outcome = await syncQueuedTurnInputs({
      cfg,
      wm: fakeWm() as never,
      sessionId: "s1",
      taskRegistry: undefined,
      tokenBaseline: undefined,
    })
    expect(outcome).toBe("continue")
    // The drain edge is REACHED (not dead-code) and the effect landed on the host.
    expect(models).toEqual(["gpt-y"])
  })

  test("DEFAULT-OFF: no gate ⇒ the port is NEVER polled (byte-identical)", () => {
    const { port, polls } = countingPort()
    pollControlRequests(buildCfg({ port, applier: {}, context: {}, env: {} }))
    expect(polls()).toBe(0)
  })

  test("GATE-OFF with slot present ⇒ still never polled (gate is load-bearing)", () => {
    const { port, polls } = countingPort()
    pollControlRequests(
      buildCfg({ port, applier: {}, context: {}, env: { QUANTA_CONTROL_REQUEST: "0" } }),
    )
    expect(polls()).toBe(0)
  })

  test("no slot at all ⇒ no-op (absent controlRequest)", () => {
    // Must not throw; nothing to assert beyond graceful return.
    pollControlRequests(buildCfg(undefined))
  })

  test("NO-THROW: a throwing port does not escape the turn seam", async () => {
    const cfg = buildCfg({
      port: {
        next: () => {
          throw new Error("hostile port")
        },
      },
      applier: {},
      context: {},
      env: { QUANTA_CONTROL_REQUEST: "1" },
    })
    // Must not reject.
    const outcome = await syncQueuedTurnInputs({
      cfg,
      wm: fakeWm() as never,
      sessionId: "s1",
      taskRegistry: undefined,
      tokenBaseline: undefined,
    })
    expect(outcome).toBe("continue")
  })
})
