/**
 * Hellgate — RFC-04 §11 / ADR-0437 follow-up: `followup_task(interrupt:true)`
 * ACTUALLY interrupts a busy child's in-flight turn.
 *
 * Closes the last functional gap: before this, `wake(reason)` ignored the
 * reason — both followup and interrupt only triggered a turn (queued for AFTER
 * the in-flight one). Now `wake("interrupt")` on a BUSY child aborts the
 * in-flight turn via the gate's per-turn AbortController (the SAME
 * AbortController→signal→stream/tool mechanism `task_stop`/`forceStop` use to
 * unwind in-flight work — no parallel abort path), then the loop parks + resumes
 * into a FRESH turn that handles the interrupting message.
 *
 * This battery proves:
 *   - GATE units: armTurn mints a per-turn signal; wake("interrupt") on a busy
 *     child aborts THAT signal (observable: the effective turn signal fires) and
 *     records pending; wasInterrupted distinguishes it; armTurn RESETS the
 *     controller (a fired interrupt never pre-aborts the next turn); IDLE
 *     interrupt = plain wake (no abort); followup NEVER aborts (regression).
 *   - END-TO-END (REAL `runAgent` child loop): a BUSY child (its turn blocked in
 *     an in-flight LLM stream) + `followup_task(interrupt:true)` ⇒ the in-flight
 *     stream's signal FIRES (the turn unwinds) AND a SECOND OBSERVABLE turn runs
 *     (fresh stream). A BUSY child + followup (non-interrupt) does NOT abort the
 *     in-flight stream (it completes, then the queued turn runs). An IDLE child +
 *     interrupt is a plain wake. The no-waker path honest-degrades unchanged.
 *
 * No real LLM; the child loop runs against scripted LLMs.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
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

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const fakeMailbox = () => {
  const sent: Array<{ to: string; body: string }> = []
  const port: MailboxSendPort = {
    send: (init) => {
      sent.push({ to: init.to, body: init.body })
      return init
    },
  }
  return { port, sent }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ─── 1. GATE units — interrupt semantics ─────────────────────────────────────

describe("SubagentTurnGate — interrupt aborts the in-flight turn", () => {
  test("busy interrupt: aborts THIS turn's signal AND records pending (resume)", async () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    // The loop is mid-turn: arm the turn and capture the effective signal.
    const turnSignal = gate.armTurn(loop.signal)
    expect(turnSignal.aborted).toBe(false)
    expect(gate.wasInterrupted()).toBe(false)

    // Busy (not parked) interrupt ⇒ the in-flight turn's signal fires + queued.
    expect(gate.wake("interrupt")).toBe("queued")
    expect(turnSignal.aborted).toBe(true) // the in-flight turn aborts NOW
    expect(gate.wasInterrupted()).toBe(true)

    // The loop unwinds to the gate; the pending interrupt-wake resumes it.
    expect(await gate.wait(loop.signal)).toBe("resume")
  })

  test("armTurn RESETS the controller — a fired interrupt never pre-aborts the next turn", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    const s1 = gate.armTurn(loop.signal)
    gate.wake("interrupt")
    expect(s1.aborted).toBe(true)
    expect(gate.wasInterrupted()).toBe(true)
    // Fresh turn ⇒ fresh controller ⇒ NOT pre-aborted.
    const s2 = gate.armTurn(loop.signal)
    expect(s2.aborted).toBe(false)
    expect(gate.wasInterrupted()).toBe(false)
  })

  test("idle interrupt = plain wake (nothing in flight to abort)", async () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    gate.armTurn(loop.signal)
    const waitP = gate.wait(loop.signal) // park (idle)
    await tick()
    expect(gate.isParked()).toBe(true)
    // Parked ⇒ interrupt just releases the park (woke); no abort needed.
    expect(gate.wake("interrupt")).toBe("woke")
    expect(await waitP).toBe("woke")
    expect(gate.wasInterrupted()).toBe(false) // nothing was aborted
  })

  test("followup (non-interrupt) NEVER aborts the in-flight turn (regression)", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    const turnSignal = gate.armTurn(loop.signal)
    // Busy followup ⇒ queued, but the in-flight turn is NOT aborted.
    expect(gate.wake("followup")).toBe("queued")
    expect(turnSignal.aborted).toBe(false)
    expect(gate.wasInterrupted()).toBe(false)
  })

  test("the effective signal also fires on a real lifetime abort", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    const turnSignal = gate.armTurn(loop.signal)
    loop.abort()
    expect(turnSignal.aborted).toBe(true)
    // wasInterrupted is FALSE — the per-turn controller did not fire (the loop
    // signal did). The loop uses the original config.signal to route this to a
    // genuine abort/finish, not an interrupt.
    expect(gate.wasInterrupted()).toBe(false)
  })

  test("interrupt before any armTurn degrades to a plain pending wake (no crash)", () => {
    const gate = new SubagentTurnGate()
    // No turn armed yet ⇒ nothing to abort; still records the pending wake.
    expect(gate.wake("interrupt")).toBe("queued")
    expect(gate.wasInterrupted()).toBe(false)
  })
})

// ─── 2. END-TO-END — interrupt a REAL runAgent child mid-turn ─────────────────

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

/** An LLM whose stream BLOCKS (a genuine in-flight turn) until its abort signal
 *  fires — then it surfaces the abort exactly like the real adapters do. The
 *  first call blocks (busy); every later call is a clean instant text turn so a
 *  resumed/fresh turn is observable. Records whether each blocking stream was
 *  released by an ABORT (proving the interrupt actually aborted in-flight work). */
class BlockingThenInstantLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  /** Per-call: did the blocking stream see its signal abort? */
  abortedAt: boolean[] = []
  /** Resolves once the FIRST (blocking) stream is actually awaiting abort. */
  blockingStarted: Promise<void>
  private resolveBlockingStarted!: () => void
  constructor() {
    this.blockingStarted = new Promise((r) => {
      this.resolveBlockingStarted = r
    })
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const myCall = this.calls
    yield { type: "text_delta", delta: `turn ${myCall}` }
    if (myCall === 1) {
      // BUSY turn: block until the (effective) turn signal aborts.
      const signal = input.signal
      this.resolveBlockingStarted()
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          this.abortedAt[myCall] = true
          return resolve()
        }
        signal?.addEventListener(
          "abort",
          () => {
            this.abortedAt[myCall] = true
            resolve()
          },
          { once: true },
        )
      })
      // Surface the abort as the real adapters do (cooperative): throw so the
      // loop's streamConsume catch routes it via config.signal.aborted check.
      throw new DOMException("aborted", "AbortError")
    }
    // Fresh/resumed turn: clean instant completion.
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("end-to-end — followup_task(interrupt) aborts a busy child mid-turn", () => {
  test("BUSY child + interrupt ⇒ in-flight stream signal FIRES + a fresh turn runs", async () => {
    const wake = new TurnWakeRegistry()
    const llm = new BlockingThenInstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(
      parentCfg({ subagentTurnWake: wake, signal: ctrl.signal }, llm),
    )

    // Spawn the child — its first turn BLOCKS in the in-flight LLM stream (busy).
    const childP = runner(baseReq({ taskId: "busy-child", signal: ctrl.signal }))
    await llm.blockingStarted // the busy turn is genuinely in flight
    expect(llm.calls).toBe(1)
    expect(wake.has("busy-child")).toBe(true)

    // followup_task(interrupt:true) against the BUSY child.
    const mailbox = fakeMailbox()
    const reg = new TaskRegistry()
    reg.register({ id: "busy-child", description: "child" })
    const out = handleFollowupTask(
      { agentId: "busy-child", message: "STOP and do this instead", interrupt: true },
      { registry: reg, mailbox: mailbox.port, wake, callerLabel: "parent" },
    )
    expect(out.kind).toBe("success")

    // PROOF the interrupt aborted in-flight work: the blocking turn-1 stream saw
    // its signal abort.
    await tick()
    await tick()
    expect(llm.abortedAt[1]).toBe(true)

    // PROOF a FRESH turn then handles the message: a second stream call runs.
    await tick()
    await tick()
    expect(llm.calls).toBe(2)
    expect(mailbox.sent.length).toBe(1) // message delivered

    // End the loop cleanly.
    ctrl.abort()
    const result = await childP
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(wake.has("busy-child")).toBe(false) // disposed in finally
  })

  test("BUSY child + followup (non-interrupt) does NOT abort the in-flight stream", async () => {
    const wake = new TurnWakeRegistry()
    const llm = new BlockingThenInstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(
      parentCfg({ subagentTurnWake: wake, signal: ctrl.signal }, llm),
    )
    const childP = runner(baseReq({ taskId: "busy-2", signal: ctrl.signal }))
    await llm.blockingStarted
    expect(llm.calls).toBe(1)

    const mailbox = fakeMailbox()
    const reg = new TaskRegistry()
    reg.register({ id: "busy-2", description: "child" })
    // NON-interrupt followup: queued, the in-flight turn must NOT be aborted.
    const out = handleFollowupTask(
      { agentId: "busy-2", message: "later" },
      { registry: reg, mailbox: mailbox.port, wake, callerLabel: "parent" },
    )
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.triggered).toBe(false) // queued, not woke

    await tick()
    await tick()
    // The in-flight stream was NOT aborted by the followup (regression guard).
    expect(llm.abortedAt[1]).toBeUndefined()
    expect(llm.calls).toBe(1) // still on the same (blocked) turn

    // Only a real lifetime abort ends it.
    ctrl.abort()
    await childP
    expect(llm.abortedAt[1]).toBe(true) // released by the lifetime abort, not the followup
  })

  test("IDLE child + interrupt is a plain wake (a second turn runs, no in-flight abort)", async () => {
    const wake = new TurnWakeRegistry()
    // An LLM that completes every turn instantly ⇒ the child is IDLE (parked).
    class InstantLLM implements LLMPort {
      calls = 0
      readonly model = "scripted"
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        this.calls += 1
        yield { type: "text_delta", delta: `t${this.calls}` }
        yield { type: "message_stop", stop_reason: "end_turn" }
      }
    }
    const llm = new InstantLLM()
    const ctrl = new AbortController()
    const runner = createSubagentRunner(
      parentCfg({ subagentTurnWake: wake, signal: ctrl.signal }, llm),
    )
    const childP = runner(baseReq({ taskId: "idle-child", signal: ctrl.signal }))
    await tick()
    await tick()
    expect(llm.calls).toBe(1) // ran one turn then parked (idle)

    const mailbox = fakeMailbox()
    const reg = new TaskRegistry()
    reg.register({ id: "idle-child", description: "child" })
    const out = handleFollowupTask(
      { agentId: "idle-child", message: "more", interrupt: true },
      { registry: reg, mailbox: mailbox.port, wake, callerLabel: "parent" },
    )
    expect(out.kind).toBe("success")
    if (out.kind === "success") expect(out.triggered).toBe(true) // woke (idle)

    await tick()
    await tick()
    expect(llm.calls).toBe(2) // a second turn ran

    ctrl.abort()
    await childP
  })

  test("no-waker honest-degrade unchanged (interrupt against a child with no live waker)", () => {
    const wake = new TurnWakeRegistry()
    const reg = new TaskRegistry()
    reg.register({ id: "child-NW", description: "child" })
    const mailbox = fakeMailbox()
    const out = handleFollowupTask(
      { agentId: "child-NW", message: "hi", interrupt: true },
      { registry: reg, mailbox: mailbox.port, wake, callerLabel: "parent" },
    )
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("no_waker")
    expect(mailbox.sent.length).toBe(1) // delivered despite no live trigger
  })
})

// ─── 3. DEFAULT-OFF — no gate ⇒ byte-identical (no interrupt machinery) ───────

describe("default-OFF — no turn-gate means no interrupt machinery", () => {
  test("a child with NO wake registry never arms a turn-gate (byte-identical)", async () => {
    let sawGate = false
    const run = (async (c: AgentConfig) => {
      sawGate = c.subagentTurnGate !== undefined
      return { reason: "completed", turns: 1, messages: [] } as never
    }) as never
    class OneShot implements LLMPort {
      readonly model = "x"
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop", stop_reason: "end_turn" }
      }
    }
    const runner = createSubagentRunner(parentCfg({}, new OneShot()), { run })
    await runner(baseReq({ taskId: "no-gate" }))
    expect(sawGate).toBe(false) // no gate ⇒ runTurn never arms/clones ⇒ byte-identical
  })
})
