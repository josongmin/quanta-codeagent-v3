import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import { type RetryWithSessionState, retryWithCmd } from "@/apps/cli/retry-with"
import type { SlashContext } from "@/apps/cli/slash-commands"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `model-swap-retry` (ADR-0066 / feature
 * 07-resilience/65-model-swap-retry). Prior coverage drove `streamWithModel` /
 * `resolveRetryModel` in ISOLATION (pure-fn unit; `runAgent = 0`) — nothing
 * proved that a turn produced by the LIVE loop actually gets RE-RUN under the
 * swapped model when the operator escalates.
 *
 * This drives the REAL chain end-to-end:
 *
 *   runAgent(base model)                  → turn 1 streams on the BASE candidate;
 *                                           the capturing base port records the
 *                                           EXACT StreamInput + proves its model.
 *     → the answer is unsatisfactory      → the operator escalates via the WIRED
 *   /retry-with (retryWithCmd)              session command …
 *       → resolveRetryModel escalates      … to the NEXT candidate in the ordered
 *          ladder (base → escalated),        list (no wrapping) …
 *         → streamWithModel(escalated)     … and RE-RUNS the same StreamInput
 *                                             against the SWAPPED candidate,
 *                                             leading `stream_reset` tombstone.
 *
 * Ground truth (`capture the model per StreamInput in a scripted multi-model
 * LLM`): the SECOND turn's StreamInput was served by the ESCALATED candidate's
 * port (its recorded model id), the BASE port was NOT re-invoked, and the
 * re-stream began with the `stream_reset` tombstone.
 */

/** A candidate port that records every StreamInput it streams + the model it
 *  served it under. `id`/`model` are distinct per candidate so the test can
 *  prove WHICH model served the re-run. */
class CapturingCandidateLLM implements LLMPort {
  readonly seenInputs: StreamInput[] = []
  calls = 0
  constructor(
    readonly model: string,
    private readonly reply: string,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.seenInputs.push(input)
    yield { type: "text_delta", delta: this.reply }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const swapConfig = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig =>
  cfg({
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    messages: [
      { role: "user", content: [{ type: "text", text: "SWAP-GO please answer the question" }] },
    ],
    maxTurns: 1,
    ...over,
  })

/** Build a `SlashContext` carrying the `/retry-with` session state. Records the
 *  re-stream events (including the leading tombstone). */
const buildRetryCtx = (
  state: RetryWithSessionState,
): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const ctx: SlashContext = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    cwd: "/tmp",
    retry: state,
  }
  return { ctx, out, err }
}

describe("model-swap-retry — real loop turn 1 → escalated re-run under the swapped model", () => {
  test("runAgent turn on base → /retry-with escalates → SECOND turn served by the swapped model", async () => {
    // Base candidate serves the live runAgent turn 1.
    const base = new CapturingCandidateLLM("base-model-v1", "first (unsatisfactory) answer")
    // The escalated candidate is what the swap re-runs against.
    const escalated = new CapturingCandidateLLM("escalated-model-v2", "second (better) answer")

    // 1. REAL loop: turn 1 runs on the base model.
    const out = await withTimeout(
      runAgent(swapConfig({ llm: base })),
      15_000,
      "model-swap-retry-turn1",
    )
    expect(out.reason).toBe("completed")
    expect(base.calls).toBe(1)
    // The base port recorded the EXACT StreamInput the live turn used — reuse it
    // verbatim for the re-run (the operator re-runs THIS turn, not a fresh one).
    const turnInput = base.seenInputs[0]
    expect(turnInput).toBeDefined()
    // The user's request reached the base turn (proves it's the real turn input).
    const inputText = (turnInput as StreamInput).messages
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .join(" ")
    expect(inputText).toContain("SWAP-GO")

    // The live transcript after turn 1 (what the operator sees before escalating).
    const messages: Message[] = [...out.messages]
    const assistantBefore = messages.filter((m) => m.role === "assistant").length
    expect(assistantBefore).toBeGreaterThanOrEqual(1)

    // 2. The answer was unsatisfactory → escalate via the WIRED /retry-with.
    const events: StreamEvent[] = []
    const { ctx, out: cmdOut } = buildRetryCtx({
      // Ordered escalation ladder: base → escalated (no wrapping past the end).
      candidates: [
        { id: base.model, port: base },
        { id: escalated.model, port: escalated },
      ],
      currentModelId: base.model,
      messages,
      streamInput: turnInput as StreamInput,
      onEvent: (ev) => {
        events.push(ev)
      },
    })
    // No requested id ⇒ escalate to the NEXT candidate after `current`.
    const code = await retryWithCmd.run([], ctx)
    expect(code).toBe(0)

    // 3. GROUND TRUTH — the SECOND turn actually ran under the SWAPPED model:
    //    the escalated candidate's port streamed exactly once, served the SAME
    //    StreamInput the live turn used, and the base was NOT re-invoked.
    expect(escalated.calls).toBe(1)
    expect(base.calls).toBe(1) // still 1 — the base was NOT re-run.
    expect(escalated.seenInputs[0]).toBe(turnInput as StreamInput)

    // 4. The re-stream began with the `stream_reset` tombstone (discard the
    //    prior partial) then forwarded the escalated model's fresh answer.
    expect(events[0]).toEqual({ type: "stream_reset" })
    expect(events.some((e) => e.type === "text_delta" && e.delta.includes("better"))).toBe(true)
    // The prior assistant turn was dropped before the re-run (swap replaces it).
    expect(messages.filter((m) => m.role === "assistant").length).toBe(assistantBefore - 1)
    expect(cmdOut.join("")).toContain(`re-streamed against ${escalated.model}`)
  })

  // ── NON-VACUITY CONTROL: escalation past the last candidate has NO alternate
  // ⇒ NO second turn runs (proves the "escalated served the re-run" assertion
  // discriminates — a swap only happens when a distinct alternate exists).
  test("CONTROL: current is the LAST candidate ⇒ no alternate, escalated port never runs", async () => {
    const base = new CapturingCandidateLLM("base-model-v1", "answer")
    const escalated = new CapturingCandidateLLM("escalated-model-v2", "unused")
    const out = await withTimeout(runAgent(swapConfig({ llm: base })), 15_000, "model-swap-last")
    expect(out.reason).toBe("completed")
    const turnInput = base.seenInputs[0] as StreamInput
    const messages: Message[] = [...out.messages]
    const events: StreamEvent[] = []
    const { ctx, err } = buildRetryCtx({
      candidates: [
        { id: base.model, port: base },
        { id: escalated.model, port: escalated },
      ],
      // current = the LAST candidate ⇒ resolveRetryModel finds NO next (no wrap).
      currentModelId: escalated.model,
      messages,
      streamInput: turnInput,
      onEvent: (ev) => {
        events.push(ev)
      },
    })
    const code = await retryWithCmd.run([], ctx)
    expect(code).toBe(1)
    // No swap happened — neither port was re-invoked and no tombstone emitted.
    expect(escalated.calls).toBe(0)
    expect(base.calls).toBe(1) // only the original live turn.
    expect(events.length).toBe(0)
    expect(err.join("")).toContain("no alternate model")
    // The transcript is untouched (no assistant turn dropped on a failed swap).
    expect(messages.filter((m) => m.role === "assistant").length).toBe(
      out.messages.filter((m) => m.role === "assistant").length,
    )
  })

  // ── EXPLICIT-MODEL CONTROL: requesting a specific candidate re-runs under THAT
  // model, not the next-in-ladder — proves the model captured on the re-run is
  // the REQUESTED one, not an artifact of ordering.
  test("explicit /retry-with <model> re-runs under the REQUESTED candidate's model", async () => {
    const base = new CapturingCandidateLLM("base-model-v1", "answer")
    const mid = new CapturingCandidateLLM("mid-model", "unused mid")
    const target = new CapturingCandidateLLM("target-model", "targeted answer")
    const out = await withTimeout(
      runAgent(swapConfig({ llm: base })),
      15_000,
      "model-swap-explicit",
    )
    const turnInput = base.seenInputs[0] as StreamInput
    const messages: Message[] = [...out.messages]
    const events: StreamEvent[] = []
    const { ctx } = buildRetryCtx({
      candidates: [
        { id: base.model, port: base },
        { id: mid.model, port: mid },
        { id: target.model, port: target },
      ],
      currentModelId: base.model,
      messages,
      streamInput: turnInput,
      onEvent: (ev) => {
        events.push(ev)
      },
    })
    // Request the LAST candidate explicitly — must skip `mid` (the next-in-ladder).
    const code = await retryWithCmd.run([target.model], ctx)
    expect(code).toBe(0)
    expect(target.calls).toBe(1)
    expect(mid.calls).toBe(0) // the escalation ladder was NOT followed.
    expect(target.seenInputs[0]).toBe(turnInput)
    expect(events[0]).toEqual({ type: "stream_reset" })
  })
})
