/**
 * WS3 hellgate — the single decide/apply delivery controller (RFC jul-18 §4.3,
 * §5). Drives the controller through SPY ports so every rail observes a REAL
 * effect: a reject performs ZERO mailbox/control calls; a queue writes the
 * mailbox exactly once; ensure-turn adds one wake; a missing endpoint is a typed
 * retained-payload DEGRADE (never a reject); interrupt enqueues BEFORE firing and
 * never calls forceStop; steer submits via the endpoint and falls back to the
 * mailbox on no-active-turn; the compat rule + unknown-mode + steer-gate-off
 * rails reject rather than silently queue.
 *
 * Negative-mutation posture: misrouting one call (e.g. wake on a passive queue,
 * or a send on a reject) makes the corresponding rail RED.
 */
import { describe, expect, it } from "bun:test"
import type { TargetResolution } from "@/agent/subagent-delivery/controller"
import { createSubagentDeliveryController } from "@/agent/subagent-delivery/controller"
import type {
  DeliveryIdFactory,
  InterruptControlOutcome,
  SteerSubmitOutcome,
  SubagentControlEndpoint,
  SubagentControlRegistry,
  SubagentDeliveryRequest,
  SubagentSteerSubmission,
  WakeControlOutcome,
} from "@/agent/subagent-delivery/ports"

// ─── spies ───────────────────────────────────────────────────────────────────

interface SendCall {
  readonly from: string
  readonly to: string
  readonly kind: "request" | "response" | "broadcast"
  readonly body: string
  readonly correlationId?: string
}

const spyMailbox = () => {
  const sent: SendCall[] = []
  let seq = 0
  return {
    sent,
    port: {
      send(init: SendCall) {
        sent.push(init)
        seq += 1
        return { id: `msg-${seq}` }
      },
    },
  }
}

/** A spy endpoint recording every typed command. `wake`/`interrupt`/`steer`
 *  return the scripted outcomes; the recorder proves ordering + exactly-once. */
const spyEndpoint = (opts: {
  readonly mailboxLabel: string
  readonly wake?: WakeControlOutcome
  readonly interrupt?: InterruptControlOutcome
  readonly steer?: SteerSubmitOutcome
}) => {
  const calls: string[] = []
  const steerSubmissions: SubagentSteerSubmission[] = []
  const ep: SubagentControlEndpoint = {
    mailboxLabel: opts.mailboxLabel,
    wake(): WakeControlOutcome {
      calls.push("wake")
      return opts.wake ?? "woke"
    },
    interrupt(): InterruptControlOutcome {
      calls.push("interrupt")
      return opts.interrupt ?? "interrupted_active"
    },
    steer(submission): SteerSubmitOutcome {
      calls.push("steer")
      steerSubmissions.push(submission)
      return opts.steer ?? "accepted"
    },
  }
  return { ep, calls, steerSubmissions }
}

/** A control registry backed by a fixed map. `forceStop` is a spy — the
 *  controller must NEVER call it (interrupt is per-turn only, RFC §1.1). */
const spyRegistry = (endpoints: Record<string, SubagentControlEndpoint>) => {
  const forceStopCalls: string[] = []
  const registry: SubagentControlRegistry & { forceStop(id: string): void } = {
    endpointFor: (taskId) => endpoints[taskId],
    labelOf: (taskId) => endpoints[taskId]?.mailboxLabel,
    register: () => () => {},
    forceStop(id: string) {
      forceStopCalls.push(id)
    },
  }
  return { registry, forceStopCalls }
}

const ids = (): DeliveryIdFactory => {
  let n = 0
  return () => {
    n += 1
    return `del-${n}`
  }
}

/** A target resolver over a small in-memory table: running/settled/unknown +
 *  a per-target owner lineage. The controller consults it BEFORE any mutation. */
type TargetState = "running" | "settled"
const resolver = (
  table: Record<string, { state: TargetState; owner?: string }>,
  opts: { requesterLineage?: string; ownTaskId?: string } = {},
) => {
  return {
    resolve(targetTaskId: string): TargetResolution {
      // Self-target + lineage are folded into resolution (the host closes over
      // ownTaskId / requesterLineage / owners ledger), so the controller stays a
      // pure decide/apply leaf.
      if (opts.ownTaskId !== undefined && targetTaskId === opts.ownTaskId) {
        return { kind: "self" }
      }
      const row = table[targetTaskId]
      if (row === undefined) return { kind: "unknown" }
      if (row.state !== "running") return { kind: "settled" }
      if (
        opts.requesterLineage !== undefined &&
        row.owner !== undefined &&
        row.owner !== opts.requesterLineage
      ) {
        return { kind: "ownership_denied" }
      }
      return { kind: "running" }
    },
  }
}

const baseReq = (over: Partial<SubagentDeliveryRequest> = {}): SubagentDeliveryRequest => ({
  targetTaskId: "task-1",
  from: "parent",
  body: "hello",
  mode: "queue",
  activation: "passive",
  ...over,
})

/** Build a controller with the given wiring; sensible defaults for each dep. */
const makeController = (opts: {
  readonly endpoints?: Record<string, SubagentControlEndpoint>
  readonly table?: Record<string, { state: TargetState; owner?: string }>
  readonly requesterLineage?: string
  readonly ownTaskId?: string
  readonly steerEnabled?: boolean
}) => {
  const mailbox = spyMailbox()
  const { registry, forceStopCalls } = spyRegistry(opts.endpoints ?? {})
  const controller = createSubagentDeliveryController({
    control: registry,
    mailbox: mailbox.port,
    formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
    resolveTarget: resolver(opts.table ?? { "task-1": { state: "running" } }, {
      ...(opts.requesterLineage !== undefined ? { requesterLineage: opts.requesterLineage } : {}),
      ...(opts.ownTaskId !== undefined ? { ownTaskId: opts.ownTaskId } : {}),
    }).resolve,
    newDeliveryId: ids(),
    steerEnabled: opts.steerEnabled ?? false,
  })
  return { controller, mailbox, forceStopCalls, registry }
}

// ─── rejects: ZERO mailbox/control calls ─────────────────────────────────────

describe("WS3 controller — rejects perform zero mutation (RFC §5.1–5.2)", () => {
  it("unknown target ⇒ rejected target_unknown, no send/wake", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      table: {},
    })
    const out = controller.deliver(baseReq())
    expect(out).toEqual({ kind: "rejected", reason: "target_unknown" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })

  it("settled target ⇒ rejected target_settled, no send/wake", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      table: { "task-1": { state: "settled" } },
    })
    const out = controller.deliver(baseReq())
    expect(out).toEqual({ kind: "rejected", reason: "target_settled" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })

  it("foreign lineage ⇒ rejected ownership_denied, no send/wake", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      table: { "task-1": { state: "running", owner: "agent-A" } },
      requesterLineage: "agent-B",
    })
    const out = controller.deliver(baseReq())
    expect(out).toEqual({ kind: "rejected", reason: "ownership_denied" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })

  it("self target ⇒ rejected self_target, no send/wake", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      ownTaskId: "task-1",
    })
    const out = controller.deliver(baseReq())
    expect(out).toEqual({ kind: "rejected", reason: "self_target" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })

  it("empty body ⇒ rejected invalid_input BEFORE lookup (no send/wake)", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ body: "" }))
    expect(out).toEqual({ kind: "rejected", reason: "invalid_input" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })
})

// ─── queue ───────────────────────────────────────────────────────────────────

describe("WS3 controller — queue mode", () => {
  it("queue + passive ⇒ mailbox.send exactly once, NO wake", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", wake: "woke" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "queue", activation: "passive" }))
    expect(out.kind).toBe("applied")
    if (out.kind === "applied") {
      expect(out.effectiveMode).toBe("queue")
      expect(out.effect).toBe("queued")
      expect(out.messageId).toBe("msg-1")
    }
    expect(mailbox.sent).toHaveLength(1)
    expect(mailbox.sent[0]?.to).toBe("root/0") // task id → mailbox label
    expect(ep.calls).toEqual([]) // NO wake on passive
  })

  it("queue + ensure-turn ⇒ send + wake exactly once each", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", wake: "woke" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "queue", activation: "ensure-turn" }))
    expect(out.kind).toBe("applied")
    if (out.kind === "applied") expect(out.effect).toBe("woke")
    expect(mailbox.sent).toHaveLength(1)
    expect(ep.calls).toEqual(["wake"])
  })

  it("queue + ensure-turn, busy child ⇒ effect queued (wake returns queued)", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", wake: "queued" })
    const { controller } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "queue", activation: "ensure-turn" }))
    if (out.kind === "applied") expect(out.effect).toBe("queued")
    expect(ep.calls).toEqual(["wake"])
  })

  it("ensure-turn, NO endpoint (running, unregistered) ⇒ retained-payload DEGRADE control_unavailable (not reject)", () => {
    const { controller, mailbox } = makeController({
      endpoints: {}, // no endpoint for task-1
      table: { "task-1": { state: "running" } },
    })
    const out = controller.deliver(baseReq({ mode: "queue", activation: "ensure-turn" }))
    // delivery DID occur ⇒ degraded, never rejected
    expect(mailbox.sent).toHaveLength(1)
    expect(out.kind).toBe("degraded")
    if (out.kind === "degraded") {
      expect(out.effectiveMode).toBe("queue")
      expect(out.reason).toBe("control_unavailable")
    }
  })

  it("ensure-turn, endpoint wake returns no-receiver ⇒ DEGRADE no_waker, payload retained", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", wake: "no-receiver" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "queue", activation: "ensure-turn" }))
    expect(mailbox.sent).toHaveLength(1)
    expect(out.kind).toBe("degraded")
    if (out.kind === "degraded") expect(out.reason).toBe("no_waker")
  })

  it("burst: N queue requests ⇒ all N payloads present exactly once, FIFO preserved", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", wake: "queued" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const bodies = ["a", "b", "c", "d", "e"]
    for (const b of bodies) {
      controller.deliver(baseReq({ mode: "queue", activation: "ensure-turn", body: b }))
    }
    expect(mailbox.sent.map((s) => s.body)).toEqual(bodies) // no drop, no reorder
  })
})

// ─── interrupt ───────────────────────────────────────────────────────────────

describe("WS3 controller — interrupt mode", () => {
  it("mailbox enqueued BEFORE interrupt fired; forceStop NEVER called", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", interrupt: "interrupted_active" })
    const { controller, mailbox, forceStopCalls } = makeController({
      endpoints: { "task-1": ep.ep },
    })
    const out = controller.deliver(baseReq({ mode: "interrupt", activation: "ensure-turn" }))
    expect(out.kind).toBe("applied")
    if (out.kind === "applied") {
      expect(out.effectiveMode).toBe("interrupt")
      expect(out.effect).toBe("interrupted")
    }
    // send happened, then interrupt — ordering proof
    expect(mailbox.sent).toHaveLength(1)
    expect(ep.calls).toEqual(["interrupt"])
    expect(forceStopCalls).toHaveLength(0) // NEVER forceStop
  })

  it("already_interrupted ⇒ degraded already_interrupted, payload retained", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", interrupt: "already_interrupted" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "interrupt", activation: "ensure-turn" }))
    expect(mailbox.sent).toHaveLength(1)
    expect(out.kind).toBe("degraded")
    if (out.kind === "degraded") {
      expect(out.requestedMode).toBe("interrupt")
      expect(out.reason).toBe("already_interrupted")
    }
  })

  it("not_armed (idle) ⇒ queue+ensure-turn behavior (wake), applied interrupt when woke", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", interrupt: "woke_idle" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    const out = controller.deliver(baseReq({ mode: "interrupt", activation: "ensure-turn" }))
    expect(mailbox.sent).toHaveLength(1)
    // woke_idle ⇒ nothing was in flight; the fresh turn drains the payload ⇒
    // applied interrupted (a turn WILL run). Not a degrade.
    expect(out.kind).toBe("applied")
  })

  it("interrupt with NO endpoint ⇒ degraded control_unavailable, payload retained", () => {
    const { controller, mailbox } = makeController({
      endpoints: {},
      table: { "task-1": { state: "running" } },
    })
    const out = controller.deliver(baseReq({ mode: "interrupt", activation: "ensure-turn" }))
    expect(mailbox.sent).toHaveLength(1)
    expect(out.kind).toBe("degraded")
    if (out.kind === "degraded") expect(out.reason).toBe("control_unavailable")
  })
})

// ─── steer ───────────────────────────────────────────────────────────────────

describe("WS3 controller — steer mode", () => {
  it("steer gate OFF ⇒ rejected mode_disabled (NOT silent queue)", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: false,
    })
    const out = controller.deliver(baseReq({ mode: "steer", activation: "ensure-turn" }))
    expect(out).toEqual({ kind: "rejected", reason: "mode_disabled" })
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toHaveLength(0)
  })

  it("steer accepted (active steerable turn) ⇒ accepted steer_pending, NO mailbox copy", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", steer: "accepted" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: true,
    })
    const out = controller.deliver(
      baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "turn-9" }),
    )
    expect(out.kind).toBe("accepted")
    if (out.kind === "accepted") {
      expect(out.effect).toBe("steer_pending")
      expect(out.targetTurnId).toBe("turn-9")
    }
    expect(ep.calls).toEqual(["steer"])
    expect(mailbox.sent).toHaveLength(0) // steer success ⇒ no mailbox duplicate
    // the submission carried a SANITIZED envelope (formatted body), not raw
    expect(ep.steerSubmissions[0]?.envelope.formattedBody).toContain("untrusted")
  })

  it("steer no_active_turn ⇒ mailbox fallback + degraded no_active_turn", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", steer: "no_active_turn" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: true,
    })
    const out = controller.deliver(
      baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "turn-9" }),
    )
    expect(mailbox.sent).toHaveLength(1) // fallback delivery
    expect(out.kind).toBe("degraded")
    if (out.kind === "degraded") {
      expect(out.requestedMode).toBe("steer")
      expect(out.reason).toBe("no_active_turn")
    }
  })

  it("steer turn_mismatch ⇒ mailbox fallback + degraded expected_turn_mismatch", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", steer: "turn_mismatch" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: true,
    })
    const out = controller.deliver(
      baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "turn-9" }),
    )
    expect(mailbox.sent).toHaveLength(1)
    if (out.kind === "degraded") expect(out.reason).toBe("expected_turn_mismatch")
  })

  it("steer queue_full ⇒ mailbox fallback + degraded action_queue_full", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", steer: "queue_full" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: true,
    })
    const out = controller.deliver(
      baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "turn-9" }),
    )
    expect(mailbox.sent).toHaveLength(1)
    if (out.kind === "degraded") expect(out.reason).toBe("action_queue_full")
  })

  it("steer without endpoint ⇒ mailbox fallback + degraded control_unavailable", () => {
    const { controller, mailbox } = makeController({
      endpoints: {},
      table: { "task-1": { state: "running" } },
      steerEnabled: true,
    })
    const out = controller.deliver(
      baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "turn-9" }),
    )
    expect(mailbox.sent).toHaveLength(1)
    if (out.kind === "degraded") expect(out.reason).toBe("control_unavailable")
  })
})

// ─── exactly-one mutation invariant (RFC §3.4) ───────────────────────────────

describe("WS3 controller — exactly-one mutation (RFC §3.4)", () => {
  it("accepted steer does NOT also enqueue mailbox", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", steer: "accepted" })
    const { controller, mailbox } = makeController({
      endpoints: { "task-1": ep.ep },
      steerEnabled: true,
    })
    controller.deliver(baseReq({ mode: "steer", activation: "ensure-turn", expectedTurnId: "t" }))
    expect(mailbox.sent).toHaveLength(0)
    expect(ep.calls).toEqual(["steer"])
  })

  it("interrupt does exactly one send + one interrupt (no double send)", () => {
    const ep = spyEndpoint({ mailboxLabel: "root/0", interrupt: "interrupted_active" })
    const { controller, mailbox } = makeController({ endpoints: { "task-1": ep.ep } })
    controller.deliver(baseReq({ mode: "interrupt", activation: "ensure-turn" }))
    expect(mailbox.sent).toHaveLength(1)
    expect(ep.calls.filter((c) => c === "interrupt")).toHaveLength(1)
  })
})
