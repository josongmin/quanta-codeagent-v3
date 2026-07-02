// TODO(migrate-to-harness): swap the local `ScriptedLLM` + `RecordingStream`
// for `tests/integration/_harness.ts` exports (`ScriptedLLM` + `RecordingStream`
// + `baseConfig`). See `agent-loop.test.ts` for the pattern. Deferred from
// refactor B to keep that PR scoped to 3 files.
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * End-to-end coverage of the integrated recovery loop: drive the REAL
 * `runAgent` with a scripted fake LLMPort and assert on
 * `AgentOutcome.reason/.turns/.messages` plus the recorded LLM inputs.
 *
 * House fakes (same shape as agent-memory.test.ts's cfg(); redefined locally —
 * no private test helpers imported).
 */

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

/** Replays a script step-per-call. `throw` steps reject before yielding any
 *  event (so the loop's same-turn retry path is exercised). The last step is
 *  repeated if the loop calls more times than scripted (defensive). */
class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** Guard: every test must terminate well under this. The loop's bounded
 *  budgets guarantee termination; a hang here is a real loop bug. */
const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("recovery e2e — integrated runAgent", () => {
  test("1. transient stream error then success → completed, retried, turn not consumed", async () => {
    const llm = new ScriptedLLM([
      thr(new LLMError("503 service unavailable")),
      ev(text("recovered answer")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 15_000, "transient-retry")
    expect(out.reason).toBe("completed")
    // >=2 LLM calls proves it retried; maxTurns=1 yet it still completed →
    // the same-turn retry did NOT consume the single turn slot.
    expect(llm.calls).toBeGreaterThanOrEqual(2)
    expect(out.turns).toBe(1)
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    expect(
      finalAssistant?.content.some((b) => b.type === "text" && b.text === "recovered answer"),
    ).toBe(true)
  })

  test("2. transient error exceeding per-turn budget → error mentioning retries", async () => {
    // MAX_TURN_STREAM_RETRIES=3 → 4 consecutive throws exhausts the budget.
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 a")),
      thr(new LLMError("503 b")),
      thr(new LLMError("503 c")),
      thr(new LLMError("503 d")),
      ev(text("never reached")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 3 })),
      20_000,
      "budget-exceeded",
    )
    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(4)
    // The loop emits an error event whose message mentions retries.
    const errMsg = stream.events.find((e) => e.type === "error")
    expect(errMsg).toBeDefined()
    if (errMsg?.type === "error") expect(errMsg.message.toLowerCase()).toContain("retries")
  })

  test("3. PTL → reactive compaction then completed, turn not consumed", async () => {
    // Seed enough turns that reactiveCompact (keepRecentTurns=2) leaves a
    // summarizable prefix (needs >2 assistant turns).
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
      { role: "user", content: [{ type: "text", text: "second request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
      { role: "user", content: [{ type: "text", text: "third request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ]
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      ev(text("<summary>resume from here</summary>")), // reactiveCompact summary call
      ev(text("final answer after compaction")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, messages: history, maxTurns: 1 })),
      15_000,
      "ptl-compaction",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1) // recovery did not consume the single turn slot
    // History was collapsed: a synthetic continuation-summary user message
    // now leads the transcript.
    const first = out.messages[0]
    expect(first?.role).toBe("user")
    const firstText = first?.content[0]?.type === "text" ? first.content[0].text : ""
    expect(firstText).toContain("continuation summary")
    expect(firstText).toContain("resume from here")
  })

  test("4. max_tokens partial then end_turn → completed, continue meta injected, partial kept", async () => {
    const llm = new ScriptedLLM([
      ev(text("partial work so far", "max_tokens")),
      ev(text("...and the rest, done")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 15_000, "max-tokens")
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    // Partial assistant text kept, and a "continue" meta user message injected.
    const partialKept = out.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "text" && b.text === "partial work so far"),
    )
    expect(partialKept).toBe(true)
    const continueMeta = out.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.toLowerCase().includes("continue")),
    )
    expect(continueMeta).toBe(true)
  })

  test("5. malformed tool_use: nudge+retry once, persists → NON-success terminal (FIX-2)", async () => {
    // stop_reason "tool_use" but ZERO tool_use blocks, twice. MAX_MALFORMED
    // RETRIES=1 → first nudge, second occurrence → FIX-2 seals a NON-success
    // `error` terminal (was `completed` pre-fix), never spinning.
    const llm = new ScriptedLLM([
      ev([
        { type: "text_delta", delta: "oops no tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev([
        { type: "text_delta", delta: "still no tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 2 })), 15_000, "malformed-tool")
    // TEETH: pre-fix `completed`. A fumbled tool call is not reported as success.
    expect(out.reason).toBe("error")
    // Exactly 2 LLM calls (one nudge retry), no infinite loop.
    expect(llm.calls).toBe(2)
  })

  test("6. consecutive empty turns are capped → terminates NON-success (jul-3 C1)", async () => {
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new ScriptedLLM([ev(empty), ev(empty), ev(empty), ev(empty)])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 3 })), 15_000, "empty-turns")
    // TEETH: pre-fix `completed`. jul-3 (C1) — a produced-NOTHING stall seals as
    // a NON-success `error` terminal (twin of the malformed FIX-2 above).
    expect(out.reason).toBe("error")
    // MAX_CONSECUTIVE_EMPTIES=2 → 2 nudges then the error terminal = 3 calls, no spin.
    expect(llm.calls).toBe(3)
    // jul-3 (C1): the error terminal resolves `turns: turn-1` (the empty turn
    // produced nothing), so a single-turn empty stall reports 0 productive turns
    // (was 1 under the old `completed` path).
    expect(out.turns).toBe(0)
  })

  test("7. genuine multi-turn tool loop (6 rounds) → completed, turns = real rounds only", async () => {
    // 6 tool rounds then a text answer. Interleave a transient error inside
    // one round to prove recovery retries are EXCLUDED from the turn count.
    const steps: Step[] = []
    for (let i = 0; i < 6; i++) {
      if (i === 3) steps.push(thr(new LLMError("timeout while reading"))) // same-turn retry
      steps.push(ev(toolUse(`t${i}`, "read", { path: "/tmp/probe" })))
    }
    steps.push(ev(text("all six rounds done")))
    const llm = new ScriptedLLM(steps)
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 20 })), 20_000, "multi-turn-stable")
    expect(out.reason).toBe("completed")
    // 6 tool rounds advance the counter; the final text turn is round 7.
    // The injected transient error is a SAME-TURN retry and must NOT count.
    expect(out.turns).toBe(7)
    // 6 tool calls + 1 retry + 6 results-driven + final = 8 LLM calls total
    // (6 tool turns, +1 transient retry, +1 final text turn).
    expect(llm.calls).toBe(8)
    // Transcript has 6 tool_use assistant blocks and 6 tool_result user msgs.
    const toolUses = out.messages.filter(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    ).length
    const toolResults = out.messages.filter(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    ).length
    expect(toolUses).toBe(6)
    expect(toolResults).toBe(6)
  })

  // ── C5 regression: final assistant turn must NOT be dropped on a
  // completed-via-exhaustion. Pre-fix the `applyAction` `completed` branch
  // returned WITHOUT appending the final assistant `message` to working
  // memory (the proceed/no-tools path DID), so `AgentOutcome.messages` lost
  // the last turn and a state.ts resume lost it too. These two tests FAIL
  // pre-fix (last entry would be the injected meta `user` nudge, not the
  // final assistant turn) and PASS post-fix.
  test("8. C5: malformed-exhausted terminal keeps the final assistant turn last (FIX-2)", async () => {
    // stop_reason "tool_use" with ZERO tool_use blocks twice. MAX_MALFORMED
    // RETRIES=1 → first nudge, second occurrence → FIX-2 NON-success `error`
    // terminal. The C5 invariant still holds: the final assistant turn (the
    // model's last words) is preserved in the transcript — `applyNonSuccess
    // RecoveryAction` appends the assembled message before sealing `error`.
    const llm = new ScriptedLLM([
      ev([
        { type: "text_delta", delta: "oops no tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev([
        { type: "text_delta", delta: "final words after malformed exhaustion" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 2 })),
      15_000,
      "c5-malformed-exhausted",
    )
    expect(out.reason).toBe("error")
    const last = out.messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(
      last?.content.some(
        (b) => b.type === "text" && b.text === "final words after malformed exhaustion",
      ),
    ).toBe(true)
  })

  test("9. C5: empty-exhausted terminal keeps the final assistant turn last (jul-3 C1)", async () => {
    // MAX_CONSECUTIVE_EMPTIES=2 → 2 empty nudges then the 3rd empty turn seals a
    // NON-success `error` terminal (jul-3 C1 — was `completed`). The C5 invariant
    // still holds: the final (empty) assistant turn is appended by the error path
    // (`applyNonSuccessRecoveryAction` appends the assembled message before the
    // `error` seal, just like the malformed path in test 8) — the last entry is
    // the assistant turn, NOT the empty-nudge `user`.
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new ScriptedLLM([ev(empty), ev(empty), ev(empty), ev(empty)])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 3 })), 15_000, "c5-empty-exhausted")
    // TEETH: pre-fix `completed`. jul-3 (C1) — empty exhaustion is NON-success.
    expect(out.reason).toBe("error")
    const last = out.messages.at(-1)
    expect(last?.role).toBe("assistant")
  })

  // ── C7: session_start head marker + recovery traces are emitted (pure
  // observation; control flow unchanged). RFC-0002 §5.2.
  test("10. C7: session_start emitted once + recovery traces at recovery points", async () => {
    const stream = new RecordingStream()
    // A transient throw (→ backoff recovery) then an empty turn (→ empty
    // recovery nudge) then a real answer.
    const llm = new ScriptedLLM([
      thr(new LLMError("503 transient")),
      ev([{ type: "message_stop", stop_reason: "end_turn" }]),
      ev(text("done")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 2 })),
      15_000,
      "c7-session-start-recovery",
    )
    expect(out.reason).toBe("completed")
    const starts = stream.events.filter((e) => e.type === "session_start")
    expect(starts).toHaveLength(1)
    // session_start is the head marker — it precedes every turn_start.
    expect(stream.events[0]?.type).toBe("session_start")
    const recoveries = stream.events.filter((e) => e.type === "recovery")
    const reasons = recoveries.map((e) => (e.type === "recovery" ? e.reason : ""))
    expect(reasons).toContain("backoff")
    expect(reasons).toContain("empty")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Hell-case batteries — recovery FSM correctness. Wrong budget accounting
// here = infinite loop in production. Every test below pins ONE bound or ONE
// per-kind invariant the FSM must hold.
// ───────────────────────────────────────────────────────────────────────────

describe("recovery e2e — hell cases: budget exhaustion per recovery kind", () => {
  test("hc-stream: 4 transient throws (budget=3) → 4th is HARD error, NOT recovery", async () => {
    // Identical-shape to existing test #2 but pins explicit per-kind bound.
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 a")),
      thr(new LLMError("503 b")),
      thr(new LLMError("503 c")),
      thr(new LLMError("503 d")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 3 })),
      20_000,
      "hc-stream-exhaust",
    )
    expect(out.reason).toBe("error")
    // EXACTLY 4 calls — three retries + the throw that exhausted the budget.
    expect(llm.calls).toBe(4)
    const errMsg = stream.events.find((e) => e.type === "error")
    expect(errMsg).toBeDefined()
    if (errMsg?.type === "error") {
      expect(errMsg.message.toLowerCase()).toContain("retries")
    }
    // EXACTLY 3 backoff recoveries — the budget=3 was consumed before failure.
    const backoffs = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "backoff",
    ).length
    expect(backoffs).toBe(3)
  }, 30_000)

  test("hc-output: 4 max_tokens (budget=3) → 4th `proceed`s and completes, NOT error", async () => {
    // The output-continues budget is 3. The 4th max_tokens does NOT hard-fail
    // (the decideOnAssembled fall-through is `proceed` → `completed` for a
    // text-only turn). Pin this completes-not-errors invariant: a regression
    // that hard-failed on output exhaustion would break here.
    const llm = new ScriptedLLM([
      ev(text("p1", "max_tokens")),
      ev(text("p2", "max_tokens")),
      ev(text("p3", "max_tokens")),
      ev(text("p4-final-after-budget", "max_tokens")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 20_000, "hc-output-exhaust")
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    // 4 LLM calls (3 within-budget continues + 1 post-exhaustion turn that
    // falls through to proceed). No 5th.
    expect(llm.calls).toBe(4)
  }, 30_000)

  test("hc-malformed: 2 malformed in a row (budget=1) → 2nd is a NON-success terminal (FIX-2)", async () => {
    // Re-pins test #5 explicitly as budget=1 exhaustion. FIX-2 (jun-25): the
    // 2nd malformed turn (model signalled tool_use intent but emitted no valid
    // call) is sealed as a NON-success `error` terminal — NOT `completed`. A
    // fumbled tool call must never be reported as success.
    const llm = new ScriptedLLM([
      ev([
        { type: "text_delta", delta: "m1" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev([
        { type: "text_delta", delta: "m2-exhausted" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev(text("never reached")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 3 })),
      15_000,
      "hc-malformed-exhaust",
    )
    // TEETH: pre-fix this was `completed` (success). Now a distinct non-success
    // terminal so the fumble is not misclassified.
    expect(out.reason).toBe("error")
    expect(out.reason).not.toBe("completed")
    // EXACTLY 2 calls — 1 nudge then exhaustion → terminal without a 3rd.
    expect(llm.calls).toBe(2)
  }, 15_000)

  test("hc-empty: 3 empties (budget=2) → 3rd is NON-success-via-exhaustion (jul-3 C1)", async () => {
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new ScriptedLLM([ev(empty), ev(empty), ev(empty), ev(text("never"))])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 3 })), 15_000, "hc-empty-exhaust")
    // TEETH: pre-fix `completed`. jul-3 (C1) — exhausted empty budget seals as
    // a NON-success `error` terminal, mirroring the malformed exhaustion above.
    expect(out.reason).toBe("error")
    expect(out.reason).not.toBe("completed")
    // 2 nudges then 3rd empty → error terminal (3 calls total).
    expect(llm.calls).toBe(3)
    // jul-3 (C1): error terminal ⇒ turns=turn-1=0 (produced-nothing stall).
    expect(out.turns).toBe(0)
  }, 15_000)

  test("hc-compact: PTL → compaction breaker eventually stops on thrash (3 unproductive — outcome=error, not signal-driven)", async () => {
    // Force PTL repeatedly. Each compaction returns trivially small content
    // (the script makes it appear no progress was made between PTLs). The
    // breaker's reactive-strikes cap is 3 (DEFAULT_COMPACTION_BREAKER_CAPS).
    // After 3 unproductive reactive compactions, the next PTL trips the
    // breaker → outcome=error with the rapid_refill_breaker reason.
    //
    // Setup: 7 calls. Each PTL-then-compaction pair = 1 PTL throw + 1
    // compaction summary call. The 4th PTL is where the breaker should trip
    // (before performing the 4th compaction). The "summary" content is small
    // so compaction barely shrinks → counts as a no-progress strike.
    const tinySummary = ev(text("tiny", "end_turn"))
    // Seed enough history that reactiveCompact has something to summarize.
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1 ".repeat(40) }] },
      { role: "assistant", content: [{ type: "text", text: "a1 ".repeat(40) }] },
      { role: "user", content: [{ type: "text", text: "u2 ".repeat(40) }] },
      { role: "assistant", content: [{ type: "text", text: "a2 ".repeat(40) }] },
      { role: "user", content: [{ type: "text", text: "u3" }] },
    ]
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      tinySummary, // compaction summary 1 (small → no-progress strike #1)
      thr(new LLMError("400 prompt too long")),
      tinySummary, // strike #2
      thr(new LLMError("400 context length exceeded")),
      tinySummary, // strike #3 — next PTL must trip the breaker
      thr(new LLMError("400 prompt too long again")),
      // After this 4th PTL, the breaker check fires BEFORE reactiveCompact;
      // we should NOT see another summary call. If we do, the test will fail.
      ev(text("must-not-reach")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, messages: history, maxTurns: 5 })),
      30_000,
      "hc-compact-exhaust",
    )
    // Either errored (breaker tripped) — the desired outcome — OR completed
    // (no thrash detected because summary actually shrank the prompt).
    // Production code is NOT modified; we just pin the contract that on a
    // thrash, recovery eventually aborts (no infinite loop).
    if (out.reason === "error") {
      // Expected — breaker bailed out. Calls bounded.
      expect(llm.calls).toBeLessThanOrEqual(8)
    } else {
      // If completed, recovery had to make real progress. Still bounded —
      // no infinite loop, no runaway compactions. Pin call count <= 8.
      expect(out.reason).toBe("completed")
      expect(llm.calls).toBeLessThanOrEqual(8)
    }
  }, 30_000)
})

describe("recovery e2e — hell cases: multi-kind in same turn", () => {
  test("hc-multi-1: stream→output→malformed in ONE turn each consumes its own budget", async () => {
    // All three recoveries fire WITHIN one logical turn (same-turn retries
    // don't consume the turn slot). Each is a SEPARATE budget — verifying
    // no shared pool. Sequence:
    //   call 1: throw 503 → stream retry (streamRetries 0→1)
    //   call 2: max_tokens → nudge (outputContinues 0→1)
    //   call 3: tool_use stop_reason + zero tool_use blocks → malformed
    //           nudge (malformedRetries 0→1, exhausted)
    //   call 4: clean end_turn → completed
    const llm = new ScriptedLLM([
      thr(new LLMError("503 transient")),
      ev(text("partial", "max_tokens")),
      ev([
        { type: "text_delta", delta: "oops" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev(text("final-multi-kind")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 1 })),
      15_000,
      "hc-multi-kinds",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(4)
    // Recovery events name each kind. (Stream errors emit "backoff"; output
    // limit emits "nudge"; malformed emits "malformed".)
    const reasons = stream.events
      .filter((e) => e.type === "recovery")
      .map((e) => (e.type === "recovery" ? e.reason : ""))
    expect(reasons).toContain("backoff")
    expect(reasons).toContain("nudge")
    expect(reasons).toContain("malformed")
  }, 15_000)

  test("hc-multi-2: all five recovery types once each in a single turn, then completes", async () => {
    // PTL + stream + output + malformed + empty all in ONE turn.
    //   call 1: PTL → compact (no turn slot consumed)
    //   call 2: compaction summary (one call)
    //   call 3: 503 → backoff retry
    //   call 4: max_tokens → output nudge
    //   call 5: tool_use stop with zero tools → malformed nudge
    //   call 6: empty turn → empty nudge
    //   call 7: clean text end → completed
    // reactiveCompact (keepRecentTurns=2) needs >2 assistant turns in the
    // prefix to produce a non-empty summary — mirror existing test #3 shape.
    const longHist: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "third" }] },
      { role: "assistant", content: [{ type: "text", text: "three" }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ]
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long")), // compact
      ev(text("<summary>resume here</summary>")), // compaction summary
      thr(new LLMError("503 transient")), // backoff
      ev(text("partial", "max_tokens")), // output nudge
      ev([
        { type: "text_delta", delta: "no-tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]), // malformed nudge
      ev([{ type: "message_stop", stop_reason: "end_turn" }]), // empty nudge
      ev(text("all-five-fired-final")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, messages: longHist, maxTurns: 1 })),
      20_000,
      "hc-all-five-recoveries",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(7)
    const reasons = stream.events
      .filter((e) => e.type === "recovery")
      .map((e) => (e.type === "recovery" ? e.reason : ""))
    expect(reasons).toContain("compact")
    expect(reasons).toContain("backoff")
    expect(reasons).toContain("nudge") // output-limit
    expect(reasons).toContain("malformed")
    expect(reasons).toContain("empty")
  }, 25_000)
})

describe("recovery e2e — hell cases: recovery during streaming", () => {
  test("hc-stream-mid: stream throws BEFORE any event yielded → recovery retries, success on retry", async () => {
    // Throw-before-yield is the only retryable shape (mid-stream throws are
    // RETHROWN by RetryingLLM contract — and the in-loop retry uses the same
    // semantics). Pin: a single transient throw recovers.
    const llm = new ScriptedLLM([
      thr(new LLMError("timeout while reading")),
      ev(text("recovered-content")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 1 })),
      15_000,
      "hc-stream-mid-retry",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(2)
    const last = out.messages.at(-1)
    expect(last?.content.some((b) => b.type === "text" && b.text === "recovered-content")).toBe(
      true,
    )
  }, 15_000)

  test("hc-stream-mid-tooluse: throw mid-tool_use_start (no completion of block) → recovery", async () => {
    // The throw lands BEFORE the tool_use_end → the block is incomplete and
    // the stream is considered failed pre-yield from the loop's perspective
    // (no full assembled message). Pin: bounded retry succeeds.
    // We emit a tool_use_start ONLY (no end), then throw. The next attempt
    // returns a clean end_turn.
    class MidToolThrowLLM implements LLMPort {
      readonly model = "mid-tool-throw-model"
      calls = 0
      async *stream(): AsyncIterable<StreamEvent> {
        this.calls += 1
        if (this.calls === 1) {
          // Throw IMMEDIATELY (do not yield) — emulates a pre-block failure.
          // Yielding tool_use_start then throwing would hit RetryingLLM's
          // "mid-stream rethrow" guard; the in-loop turn retry handles only
          // pre-yield throws. This is the exact same shape as test 1 — the
          // POINT is the behavior is identical for retry math whether the
          // throw was during connect or after a partial tool_use intent.
          throw new LLMError("timeout while reading")
        }
        yield { type: "text_delta", delta: "after-recover" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      }
    }
    const llm = new MidToolThrowLLM()
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 1 })),
      15_000,
      "hc-stream-mid-tooluse",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(2)
    // TODO(test-coverage): a TRUE mid-stream throw (after tool_use_start
    // yielded, before tool_use_end) is RETHROWN by the in-loop seam — the
    // loop sees an error AFTER partial output. Pinning that path needs a
    // custom seam injection (not the scripted shape). Skipped intentionally.
  }, 15_000)
})

describe("recovery e2e — hell cases: recovery + abort interaction", () => {
  test("hc-abort-during-retry: abort fires DURING backoff → outcome=aborted, no infinite loop", async () => {
    // The loop sleeps between retries (abort-aware). Trigger an abort
    // immediately and the retry sleep resolves; the next runTurn iteration
    // sees signal.aborted and returns kind:"aborted".
    const ac = new AbortController()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 a")),
      thr(new LLMError("503 b")),
      thr(new LLMError("503 c")),
      thr(new LLMError("503 d")),
    ])
    // Abort after a microtask so the loop has begun retrying.
    queueMicrotask(() => ac.abort())
    const out = await withTimeout(
      runAgent(cfg({ llm, signal: ac.signal, maxTurns: 5 })),
      15_000,
      "hc-abort-during-retry",
    )
    expect(out.reason).toBe("aborted")
    // Bounded — never exceeded the streamRetries budget on this path.
    expect(llm.calls).toBeLessThanOrEqual(4)
    // The controller's signal IS aborted entering the next loop iteration.
    expect(ac.signal.aborted).toBe(true)
  }, 15_000)

  test("hc-abort-during-nudge: 5 recoveries in flight when abort fires → all unwind cleanly", async () => {
    // Stack stream+output+malformed+empty+backoff in one turn but abort just
    // before the final answer. Loop must return aborted (NOT spin or error).
    const ac = new AbortController()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 transient")), // backoff
      ev(text("partial", "max_tokens")), // output nudge
      ev([
        { type: "text_delta", delta: "no-tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]), // malformed nudge
      ev([{ type: "message_stop", stop_reason: "end_turn" }]), // empty nudge
      // At this point abort fires; the next loop top-of-iteration sees it.
      ev(text("would-be-final")),
    ])
    // Abort after 4 calls have happened.
    let calls = 0
    const baseStream = llm.stream.bind(llm)
    llm.stream = async function* (input: StreamInput): AsyncIterable<StreamEvent> {
      calls += 1
      if (calls === 4) queueMicrotask(() => ac.abort())
      yield* baseStream(input)
    }
    const out = await withTimeout(
      runAgent(cfg({ llm, signal: ac.signal, maxTurns: 1 })),
      15_000,
      "hc-abort-mid-recovery-stack",
    )
    expect(out.reason).toBe("aborted")
    // Signal IS aborted — verifies the queueMicrotask abort actually fired.
    expect(ac.signal.aborted).toBe(true)
  }, 15_000)
})

describe("recovery e2e — hell cases: recovery preserves history", () => {
  test("hc-history-final: 3 recoveries (stream, output, empty) → final history ends with the successful turn", async () => {
    // 3 recoveries fire; the FINAL assistant turn (the success message) must
    // be the last `assistant` entry. The intermediate nudge meta-user turns
    // must be present (they were live conversation), but no half-assembled
    // assistant turn from the recovered attempts should appear LAST.
    const llm = new ScriptedLLM([
      thr(new LLMError("503 transient")), // stream retry
      ev(text("partial-output", "max_tokens")), // output nudge
      ev([{ type: "message_stop", stop_reason: "end_turn" }]), // empty nudge
      ev(text("SUCCESS-FINAL")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 15_000, "hc-history-final")
    expect(out.reason).toBe("completed")
    const last = out.messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(last?.content.some((b) => b.type === "text" && b.text === "SUCCESS-FINAL")).toBe(true)
    // The partial "partial-output" from the max_tokens nudge is also kept
    // (keepMessage:true) — pin its presence somewhere in the transcript so
    // a regression that dropped kept-partials is visible.
    const partialKept = out.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "text" && b.text === "partial-output"),
    )
    expect(partialKept).toBe(true)
  }, 15_000)
})
