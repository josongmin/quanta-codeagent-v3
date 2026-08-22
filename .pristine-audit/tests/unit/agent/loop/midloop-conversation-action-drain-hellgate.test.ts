/**
 * UUX-5-05 Hellgate — conversation-actions must drain INSIDE the same-turn
 * loop, not only at the turn boundary.
 *
 * Ground truth (verified against the loop, NOT the ticket's premise): tool
 * ROUNDS each return `{kind:"tools"}` to the OUTER loop, whose
 * `prepareTurnIteration` → `syncQueuedTurnInputs` already drains between
 * rounds. The genuinely UN-drained window was the SAME-turn re-stream loop in
 * `runTurn` (empty/malformed nudges, transient retries, PTL recovery,
 * guard-blocked rounds): a turn cycling there runs multiple LLM streams with
 * ZERO drains, so a queued `/summarize-now` or `/cancel` waited for the whole
 * turn to seal. (Draining WITHIN one stream round — mid-dispatch — is
 * structurally unsafe for compaction: the assistant message under assembly is
 * not yet in `wm`, so `wm.replace` could orphan in-flight tool_use ids. That
 * window deliberately stays un-drained; see same-turn-engine.)
 *
 * Fix under test: `runTurn` calls `drainConversationActionsMidTurn` at the top
 * of every same-turn iteration after the first — the same structurally-safe
 * seam the proactive compaction already uses.
 *
 * The same-turn iteration is driven deterministically via the EMPTY-response
 * nudge: stream 1 yields an empty assistant message ⇒ `decideEmpty` elects a
 * same-turn nudge ⇒ CONTINUE ⇒ stream 2 runs in the SAME `runTurn` call.
 *
 * Battery:
 *   §1 RED (core) — a `summarize` queued during stream 1 applies BEFORE the
 *      turn's next stream/tool round (order: stream:1 → summarize → stream:2).
 *   §2 `/cancel` queued during stream 1 aborts the turn BEFORE stream 2 runs
 *      and captures the partial turn (resume parity with the boundary path).
 *   §3 OFF-gate byte-identity — no `conversationActionPort` wired (the
 *      QUANTA_CONVERSATION_ACTIONS gate leaves the slot absent) ⇒ the same-turn
 *      loop is untouched: same streams/rounds, zero summarizer calls, no
 *      compact/error signals.
 *   §4 OFF-gate witness (structural) — with the port absent the mid-loop drain
 *      helper reads NOTHING else off the config and touches neither wm nor
 *      stream (Proxy witness: property-access set == {conversationActionPort}).
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runTurn } from "@/agent/loop/same-turn-engine"
import { drainConversationActionsMidTurn } from "@/agent/loop/turn-iteration"
import { resolveTurnLoopOutcome } from "@/agent/loop/turn-outcome"
import { freshRecovery } from "@/agent/recovery"
import type { ActiveTurnState } from "@/agent/steering"
import type { TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

// ─── doubles ─────────────────────────────────────────────────────────────────

/** Scripted primary LLM that logs each stream into the shared `order` log and
 *  fires `onStream(n)` so a test can arm a mid-turn action "while the model is
 *  running" (the exact moment a user types /summarize-now or /cancel). */
class ScriptedLLM implements LLMPort {
  readonly model = "scripted-test-model"
  streamCalls = 0
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(
    scripts: StreamEvent[][],
    private readonly order: string[],
    private readonly onStream?: (n: number) => void,
  ) {
    this.scripts = [...scripts]
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.streamCalls += 1
    this.order.push(`stream:${this.streamCalls}`)
    this.onStream?.(this.streamCalls)
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const e of next ?? this.last) yield e
  }
}

/** Summarizer double that records WHEN it ran into the shared `order` log. */
class OrderRecordingSummarizer implements LLMPort {
  callCount = 0
  constructor(private readonly order: string[]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount++
    this.order.push("summarize")
    yield { type: "text_delta", delta: "SUMMARY" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Stream 1: an EMPTY assistant turn ⇒ same-turn "empty" nudge ⇒ CONTINUE. */
const emptyRound = (): StreamEvent[] => [{ type: "message_stop", stop_reason: "end_turn" }]
const toolRound = (id: string, tag: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "echo" },
  { type: "tool_use_end", id, input: { tag } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const u = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })
const a = (t: string): Message => ({ role: "assistant", content: [{ type: "text", text: t }] })

/** Several closed turns so `compactIfNeeded(force:true)` finds a boundary. */
const seededHistory = (): Message[] => {
  const m: Message[] = []
  for (let i = 0; i < 8; i++) m.push(u(`task ${i}`), a(`work ${i}`))
  m.push(u("go"))
  return m
}

const activeMain: ActiveTurnState = {
  currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
  isInterrupted: false,
}

/** An echo tool that logs execution order. */
const makeEchoTool = (order: string[]): Tool => ({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ tag: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: (input: unknown) =>
    (async function* () {
      order.push(`tool:${(input as { tag: string }).tag}`)
      yield { type: "result" as const, result: { ok: true, output: "ran" } }
    })(),
})

const makeHarness = (args: {
  readonly order: string[]
  readonly llm: LLMPort
  readonly port?: { next(): { kind: string; reason?: string } | undefined }
  readonly summarizer?: LLMPort
  readonly interruptedTurnBuffer?: { capture(t: unknown): void; take(): unknown }
}): { session: TurnSession; state: TurnState; stream: RecordingStream } => {
  const registry = new ToolRegistry([makeEchoTool(args.order)])
  const stream = new RecordingStream()
  const config = {
    llm: args.llm,
    registry,
    stream,
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => true,
    activeTurnRef: { current: activeMain },
    ...(args.port !== undefined ? { conversationActionPort: args.port } : {}),
    ...(args.summarizer !== undefined ? { compaction: { summarizerLlm: args.summarizer } } : {}),
    ...(args.interruptedTurnBuffer !== undefined
      ? { interruptedTurnBuffer: args.interruptedTurnBuffer }
      : {}),
  } as unknown as AgentConfig
  const session: TurnSession = { config, specs: registry.specs(), guards: [] }
  const state: TurnState = {
    wm: createWorkingMemory<Message>(seededHistory()),
    rec: freshRecovery(),
    breaker: undefined,
    toolHistory: undefined,
    workingState: undefined,
    collector: undefined,
    toolChoiceState: {} as TurnState["toolChoiceState"],
    citations: [],
    onRedaction: () => {},
    onTurnTiming: undefined,
    tokenBaseline: {},
  }
  return { session, state, stream }
}

/** One-shot action port armed externally (simulates a slash command queued
 *  WHILE the turn is executing — the exact gap this hellgate pins). */
const oneShotPort = (action: { kind: string; reason?: string }) => {
  let armed = false
  let served = false
  return {
    arm: () => {
      armed = true
    },
    next: () => {
      if (!armed || served) return undefined
      served = true
      return action
    },
  }
}

// ─── §1 RED — summarize applies before the turn's next stream/tool round ─────

describe("UUX-5-05 §1 — mid-turn /summarize-now drains inside the same-turn loop", () => {
  test("a summarize queued during stream 1 runs BEFORE the same turn's next round", async () => {
    const order: string[] = []
    const summarizer = new OrderRecordingSummarizer(order)
    const port = oneShotPort({ kind: "summarize" })
    // stream 1 = empty (⇒ same-turn nudge ⇒ CONTINUE), stream 2 = a tool round.
    const llm = new ScriptedLLM([emptyRound(), toolRound("c1", "1")], order, (n) => {
      if (n === 1) port.arm() // the user queues /summarize-now while stream 1 runs
    })
    const { session, state } = makeHarness({ order, llm, port, summarizer })

    const result = await runTurn(1, session, state)

    expect(result.kind).toBe("tools")
    expect(summarizer.callCount).toBe(1)
    // THE load-bearing assertion: the on-demand summarize applied between the
    // same-turn rounds — before the turn's LAST (tool) round, not deferred to
    // the outer boundary after the turn sealed.
    expect(order).toEqual(["stream:1", "summarize", "stream:2", "tool:1"])
    // The compaction actually took effect on live wm (not just a summarizer call).
    const texts = state.wm
      .snapshot()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
    expect(texts.some((t) => t.includes("SUMMARY"))).toBe(true)
  })
})

// ─── §2 — mid-turn /cancel aborts before the next round + captures ──────────

describe("UUX-5-05 §2 — mid-turn /cancel unwinds inside the same-turn loop", () => {
  test("a cancel queued during stream 1 aborts the turn; stream 2 NEVER runs; partial turn captured", async () => {
    const order: string[] = []
    const captured: unknown[] = []
    const port = oneShotPort({ kind: "cancel", reason: "user cancelled" })
    const llm = new ScriptedLLM([emptyRound(), toolRound("c1", "1")], order, (n) => {
      if (n === 1) port.arm()
    })
    const { session, state, stream } = makeHarness({
      order,
      llm,
      port,
      interruptedTurnBuffer: {
        capture: (t: unknown) => captured.push(t),
        take: () => null,
      },
    })

    const result = await runTurn(1, session, state)

    expect(result.kind).toBe("aborted")
    expect(order).toEqual(["stream:1"]) // stream 2 / the tool round never ran
    // Resume parity with the boundary /cancel path: the partial turn is captured.
    expect(captured.length).toBe(1)
    expect((captured[0] as { reason: string }).reason).toBe("user cancelled")
    // The interrupt is observable on the stream (emitInterrupted from the poll).
    expect(stream.events.some((e) => e.type === "interrupted")).toBe(true)
  })
})

// ─── §2b — the outer aborted arm must NOT clobber the precise capture ────────

describe("UUX-5-05 §2b — no double-capture: the outer arm honors `captured:true`", () => {
  const outcomeArgs = (result: import("@/agent/loop/types").TurnResult, captured: unknown[]) =>
    ({
      cfg: {
        stream: { emit: () => {} },
        interruptedTurnBuffer: { capture: (t: unknown) => captured.push(t), take: () => null },
      } as unknown as AgentConfig,
      stream: { emit: () => {} },
      wm: createWorkingMemory<Message>([u("go")]),
      breaker: undefined,
      recorder: undefined,
      turn: 2,
      result,
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    }) as Parameters<typeof resolveTurnLoopOutcome>[0]

  test("aborted+captured (mid-turn /cancel) ⇒ outer arm does NOT re-capture (reason preserved)", async () => {
    const captured: unknown[] = []
    const res = await resolveTurnLoopOutcome(
      outcomeArgs({ kind: "aborted", captured: true }, captured),
    )
    expect(res).toMatchObject({ kind: "finish", reason: "aborted" })
    expect(captured).toEqual([]) // the drain's conversation_cancel capture survives
  })

  test("PAIRED CONTROL: plain aborted (no flag) ⇒ outer arm still captures (pre-existing behavior)", async () => {
    const captured: unknown[] = []
    const res = await resolveTurnLoopOutcome(outcomeArgs({ kind: "aborted" }, captured))
    expect(res).toMatchObject({ kind: "finish", reason: "aborted" })
    expect(captured.length).toBe(1)
    expect((captured[0] as { reason: string }).reason).toBe("turn_result_abort")
  })

  test("END-TO-END reason fidelity: mid-turn /cancel through runTurn + the outer arm keeps 'user cancelled'", async () => {
    // The live wiring: runTurn returns {kind:"aborted", captured:true} and the
    // outer resolve must leave the drain's precise-reason capture in the buffer.
    const order: string[] = []
    const captured: Array<{ reason: string }> = []
    const port = oneShotPort({ kind: "cancel", reason: "user cancelled" })
    const llm = new ScriptedLLM([emptyRound(), toolRound("c1", "1")], order, (n) => {
      if (n === 1) port.arm()
    })
    const { session, state } = makeHarness({
      order,
      llm,
      port,
      interruptedTurnBuffer: {
        capture: (t: unknown) => captured.push(t as { reason: string }),
        take: () => null,
      },
    })
    const result = await runTurn(1, session, state)
    await resolveTurnLoopOutcome({
      cfg: session.config,
      stream: session.config.stream,
      wm: state.wm,
      breaker: undefined,
      recorder: undefined,
      turn: 1,
      result,
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    })
    // Exactly ONE capture, with the /cancel's precise reason — not clobbered by
    // a second generic turn_result_abort capture from the outer arm.
    expect(captured.map((c) => c.reason)).toEqual(["user cancelled"])
  })
})

// ─── §3 — OFF gate (no port wired) ⇒ same-turn loop byte-identical ───────────

describe("UUX-5-05 §3 — QUANTA_CONVERSATION_ACTIONS off (port absent) is inert", () => {
  test("no port ⇒ identical rounds, zero summarizer calls, no compact/error signals", async () => {
    const order: string[] = []
    const summarizer = new OrderRecordingSummarizer(order)
    const llm = new ScriptedLLM([emptyRound(), toolRound("c1", "1")], order)
    const { session, state, stream } = makeHarness({ order, llm, summarizer /* NO port */ })

    const result = await runTurn(1, session, state)

    // Paired control vs §1: the ONLY config delta is the absent port — the
    // same-turn loop runs its rounds untouched, no summarize is interleaved.
    expect(result.kind).toBe("tools")
    expect(order).toEqual(["stream:1", "stream:2", "tool:1"])
    expect(summarizer.callCount).toBe(0)
    expect(stream.events.filter((e) => e.type === "error")).toEqual([])
    expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "compact")).toEqual([])
  })
})

// ─── §4 — OFF-gate structural witness (helper reads NOTHING when port absent) ─

describe("UUX-5-05 §4 — mid-loop drain helper is a total no-op without a port", () => {
  test("port absent ⇒ only `conversationActionPort` is read; wm/stream untouched", async () => {
    const reads = new Set<string>()
    const cfg = new Proxy(
      {},
      {
        get: (_t, prop) => {
          reads.add(String(prop))
          return undefined
        },
      },
    ) as unknown as AgentConfig
    const wm = {
      append: () => {
        throw new Error("wm.append must not be called")
      },
      snapshot: () => {
        throw new Error("wm.snapshot must not be called")
      },
      replace: () => {
        throw new Error("wm.replace must not be called")
      },
    }

    const outcome = await drainConversationActionsMidTurn({
      cfg,
      wm: wm as never,
      taskRegistry: undefined,
      tokenBaseline: undefined,
    })

    expect(outcome).toBe("continue")
    expect([...reads]).toEqual(["conversationActionPort"])
  })
})
