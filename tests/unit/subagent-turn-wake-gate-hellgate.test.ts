/**
 * Hellgate — RFC-04 §11 / ADR-0437 follow-up: per-child turn-wake gate.
 *
 * Closes the ADR-0437 known limitation: `followup_task` delivered the message
 * but `wake()` always reported `no-receiver` (`cause:"no_waker"`) because the
 * runner never registered a per-child waker. This battery proves:
 *
 *   - GATE units: idle→woke, busy→queued (pending consumed next wait),
 *     abort→settle, dispose→settle + no-receiver after.
 *   - RUNNER wiring: a waker is registered under the child's TASK ID; a wake
 *     finds it; dispose unregisters (post-completion wake ⇒ no-receiver).
 *   - END-TO-END (REAL `runAgent` child loop): an idle child + `followup_task`
 *     ⇒ `wake` returns "woke" AND the child loop runs ANOTHER OBSERVABLE turn
 *     (the scripted LLM is called again). A busy child ⇒ "queued" + the queued
 *     turn runs next. The default-OFF path (no wake registry) is byte-identical
 *     and `followup_task` still honest-degrades to `no_waker`.
 *
 * No real LLM; the child loop runs against a counting ScriptedLLM.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  createSubagentDeliveryController,
  createTargetResolver,
  type DeliveryMailboxPort,
  type SubagentControlRegistry,
} from "@/agent/subagent-delivery"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"
import type { SubagentRequest } from "@/subagent"
import {
  handleFollowupTask,
  type MailboxSendPort,
  SubagentTurnGate,
  TaskRegistry,
  TurnWakeRegistry,
} from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── shared doubles ──────────────────────────────────────────────────────────

/** Counts stream() calls so a "did another turn run?" assertion is exact. A
 *  per-call script may park-or-finish; the fall-through is a clean text turn. */
class CountingLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const ev: StreamEvent[] = [
      { type: "text_delta", delta: `turn ${this.calls}` },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const e of ev) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const fakeMailbox = () => {
  const sent: Array<{ to: string; body: string }> = []
  let seq = 0
  const port: MailboxSendPort = {
    send: (init) => {
      sent.push({ to: init.to, body: init.body })
      seq += 1
      return { id: `msg-${seq}` }
    },
  }
  return { port, sent }
}

/** WS3: `followup_task` consumes the delivery CONTROLLER (RFC §4.4), driven over
 *  the real endpoint the runner registered into `wake`. Preserves every
 *  wake/queue/no_waker assertion below. */
const followupDeps = (
  reg: TaskRegistry,
  mailbox: ReturnType<typeof fakeMailbox>,
  wake: TurnWakeRegistry,
) => {
  const control = wake as unknown as SubagentControlRegistry
  return {
    delivery: createSubagentDeliveryController({
      control,
      mailbox: mailbox.port as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
      resolveTarget: createTargetResolver({ registry: reg, control }),
      newDeliveryId: (() => {
        let n = 0
        return () => {
          n += 1
          return `del-${n}`
        }
      })(),
      steerEnabled: false,
    }),
    callerLabel: "parent",
  }
}

/** A flush of the microtask/timer queue so a parked `await gate.wait()` and the
 *  loop's continuation settle before we assert. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ─── 1. GATE units ───────────────────────────────────────────────────────────

describe("SubagentTurnGate — idle vs busy", () => {
  test("idle: a wake WHILE parked resolves the park with 'woke'", async () => {
    const gate = new SubagentTurnGate()
    const ctrl = new AbortController()
    const waitP = gate.wait(ctrl.signal)
    await tick()
    expect(gate.isParked()).toBe(true)
    expect(gate.wake("followup")).toBe("woke")
    expect(await waitP).toBe("woke")
    expect(gate.isParked()).toBe(false)
  })

  test("busy: a wake while NOT parked is 'queued' and the next wait 'resume's", async () => {
    const gate = new SubagentTurnGate()
    const ctrl = new AbortController()
    // Not parked yet (the loop is mid-turn) ⇒ queued.
    expect(gate.wake("followup")).toBe("queued")
    expect(gate.isParked()).toBe(false)
    // Next park consumes the pending wake immediately ⇒ resume (turn runs).
    expect(await gate.wait(ctrl.signal)).toBe("resume")
    // Pending was consumed; a fresh park now blocks.
    const p = gate.wait(ctrl.signal)
    await tick()
    expect(gate.isParked()).toBe(true)
    ctrl.abort()
    expect(await p).toBe("settle")
  })

  test("abort while parked ⇒ settle (the loop finishes — no timer needed)", async () => {
    const gate = new SubagentTurnGate()
    const ctrl = new AbortController()
    const p = gate.wait(ctrl.signal)
    await tick()
    ctrl.abort()
    expect(await p).toBe("settle")
  })

  test("already-aborted signal ⇒ settle without parking", async () => {
    const gate = new SubagentTurnGate()
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await gate.wait(ctrl.signal)).toBe("settle")
    expect(gate.isParked()).toBe(false)
  })

  test("dispose releases a park with settle; subsequent wait ⇒ settle", async () => {
    const gate = new SubagentTurnGate()
    const ctrl = new AbortController()
    const p = gate.wait(ctrl.signal)
    await tick()
    gate.dispose()
    expect(await p).toBe("settle")
    expect(await gate.wait(ctrl.signal)).toBe("settle")
  })
})

// ─── 2. RUNNER waker registration ────────────────────────────────────────────

const parentCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: new CountingLLM(),
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

describe("createSubagentRunner — waker registration (ADR-0437)", () => {
  test("registers a waker under req.taskId when a wake registry is wired", async () => {
    const wake = new TurnWakeRegistry()
    let registeredAt: boolean | undefined
    // A run that observes the registry state mid-flight, then completes.
    const run = (async () => {
      registeredAt = wake.has("task-1")
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(parentCfg({ subagentTurnWake: wake }), { run })
    await runner(baseReq({ taskId: "task-1" }))
    expect(registeredAt).toBe(true)
    // Disposed after the loop ends ⇒ a later wake finds no receiver.
    expect(wake.has("task-1")).toBe(false)
    expect(wake.wake("task-1", "followup")).toBe("no-receiver")
  })

  test("NO waker without a wake registry (default-OFF)", async () => {
    let sawGate = false
    const run = (async (c: AgentConfig) => {
      sawGate = c.subagentTurnGate !== undefined
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(parentCfg(), { run })
    await runner(baseReq({ taskId: "task-1" }))
    expect(sawGate).toBe(false) // no gate threaded onto the child ⇒ byte-identical
  })

  test("NO waker without a taskId (foreground/legacy path)", async () => {
    const wake = new TurnWakeRegistry()
    let sawGate = false
    const run = (async (c: AgentConfig) => {
      sawGate = c.subagentTurnGate !== undefined
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    const runner = createSubagentRunner(parentCfg({ subagentTurnWake: wake }), { run })
    await runner(baseReq()) // no taskId ⇒ no waker keyed-on / no gate
    expect(sawGate).toBe(false)
    expect(wake.has("task-1")).toBe(false)
  })
})

// ─── 3. END-TO-END: a wake makes the REAL child loop run another turn ────────

describe("end-to-end — followup_task wakes a real runAgent child loop", () => {
  test("idle child + wake ⇒ 'woke' AND a second OBSERVABLE turn runs", async () => {
    const wake = new TurnWakeRegistry()
    const llm = new CountingLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(
      parentCfg({ subagentTurnWake: wake, llm, signal: ctrl.signal }),
      // real runAgent (default run) — we drive a genuine child loop.
    )

    // Spawn the child loop (do NOT await — it parks after turn 1).
    const childP = runner(baseReq({ taskId: "child-A", signal: ctrl.signal }))

    // Let the child run its first turn and PARK on the gate (idle).
    await tick()
    await tick()
    expect(llm.calls).toBe(1)
    expect(wake.has("child-A")).toBe(true)

    // followup_task delivers + wakes. The child was idle ⇒ "woke".
    const mailbox = fakeMailbox()
    const reg = new TaskRegistry()
    const id = reg.newId() // a separate registry view is fine — followup wakes by id
    reg.register({ id: "child-A", description: "child" })
    void id
    const out = handleFollowupTask(
      { agentId: "child-A", message: "do more" },
      followupDeps(reg, mailbox, wake),
    )
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.triggered).toBe(true) // woke

    // The wake unparked the loop ⇒ a SECOND turn actually runs.
    await tick()
    await tick()
    expect(llm.calls).toBe(2)

    // End the loop: abort ⇒ the next park settles ⇒ runAgent resolves.
    ctrl.abort()
    const result = await childP
    expect(result.turns).toBeGreaterThanOrEqual(2)
    // Post-completion the waker is gone (disposed in finally).
    expect(wake.has("child-A")).toBe(false)
  })

  test("busy child: wake-before-park is 'queued' and that turn runs next", async () => {
    // Drive the GATE directly against the loop semantics: a wake that arrives
    // before the loop parks must be observed by the NEXT park (queued→resume).
    const wake = new TurnWakeRegistry()
    const gate = new SubagentTurnGate()
    // WS3: the controller drives the typed ENDPOINT, so bridge the endpoint's
    // wake to the gate (the runner does exactly this). A mid-turn wake ⇒ gate
    // returns "queued".
    const unreg = wake.registerEndpoint("busy-1", {
      mailboxLabel: "busy-1",
      wake: () => gate.wake("followup"),
      interrupt: () => "interrupted_active",
      steer: () => "accepted",
    })
    const reg = new TaskRegistry()
    reg.register({ id: "busy-1", description: "child" })
    const mailbox = fakeMailbox()

    // Loop is mid-turn (not parked). followup_task ⇒ queued.
    const out = handleFollowupTask(
      { agentId: "busy-1", message: "later" },
      followupDeps(reg, mailbox, wake),
    )
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.triggered).toBe(false) // queued

    // When the loop reaches its completion point and parks, the pending wake
    // makes it run another turn (resume) instead of finishing.
    expect(await gate.wait(new AbortController().signal)).toBe("resume")
    unreg()
  })

  test("default-OFF: no wake registry ⇒ followup honest-degrades to no_waker, child finishes", async () => {
    const llm = new CountingLLM()
    const runner = createSubagentRunner(parentCfg({ llm }))
    // No subagentTurnWake ⇒ no gate ⇒ the child completes after one turn.
    const result = await runner(baseReq({ taskId: "child-Z" }))
    expect(result.ok).toBe(true)
    expect(llm.calls).toBe(1) // one turn, no parking, byte-identical

    // followup_task against a registry with no registered waker ⇒ no_waker, but
    // the mailbox delivery still stands.
    const wake = new TurnWakeRegistry()
    const reg = new TaskRegistry()
    reg.register({ id: "child-Z", description: "child" })
    const mailbox = fakeMailbox()
    const out = handleFollowupTask(
      { agentId: "child-Z", message: "hi" },
      followupDeps(reg, mailbox, wake),
    )
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("no_waker")
    expect(mailbox.sent.length).toBe(1) // delivered despite no trigger
  })
})
