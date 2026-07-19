import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput, ThinkingConfig } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `adaptive-thinking` (QUANTA_ADAPTIVE_THINKING,
 * RFC docs/plans/jun-6-adaptive-thinking.md).
 *
 * Prior coverage (`tests/unit/adaptive-thinking-hellgate.test.ts`) drives the
 * PRODUCER `applyEffortClassifierFloor(...)` and the codec in ISOLATION — it
 * proves the decision function and the wire shaping, but the FULL
 * `runAgent × scripted-LLM` chain (the loop resolves the per-turn thinking field
 * and it actually LANDS on `llm.stream(input).thinking`) was never exercised.
 *
 * This drives the REAL loop:
 *
 *   runAgent(config, model = claude-opus-4-8, sessionEffort ⇒ "high")
 *     → streamConsume → applyEffortClassifierFloor (reads runtimeConfig().adaptiveThinking)
 *       → the per-turn `thinking` field is threaded into `llm.stream(input)`
 *
 * GROUND TRUTH is captured OFF the real stream input the loop hands the model
 * (`RecordingThinkingLLM.thinkings`), not off the producer function's return.
 *
 * Gate ON  + adaptive-capable model ⇒ every turn's stream input carries
 *            `{type:"adaptive"}` (NO budget_tokens).
 * Gate OFF (paired control)         ⇒ the SAME model + effort carries the manual
 *            `{type:"enabled",budget_tokens}` arm instead — RED if the loop were
 *            unconditionally adaptive.
 */

const OPUS = "claude-opus-4-8"

/** LLMPort whose model is adaptive-capable and which RECORDS the `thinking`
 *  field of every stream input the loop hands it. Scripts a single completing
 *  text turn so `runAgent` reaches exactly one sampling call then finishes. */
class RecordingThinkingLLM implements LLMPort {
  readonly thinkings: (ThinkingConfig | undefined)[] = []
  calls = 0
  constructor(readonly model: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.thinkings.push(input.thinking)
    this.calls += 1
    yield* text("done")
  }
}

const adaptiveConfig = (llm: LLMPort, effort: "high" | undefined): AgentConfig =>
  cfg({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    maxTurns: 3,
    // A session effort tier drives a >0 budget so thinking IS requested — the
    // knob then only decides the SHAPE (adaptive vs manual). "default"/undefined
    // ⇒ no thinking at all, which would make the shape assertion vacuous.
    ...(effort !== undefined ? { sessionEffort: () => effort } : {}),
  })

describe("adaptive-thinking — real runAgent loop threads the thinking shape to the model", () => {
  const origGate = process.env.QUANTA_ADAPTIVE_THINKING

  beforeEach(() => {
    delete process.env.QUANTA_ADAPTIVE_THINKING
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (origGate === undefined) delete process.env.QUANTA_ADAPTIVE_THINKING
    else process.env.QUANTA_ADAPTIVE_THINKING = origGate
    __resetRuntimeConfig()
  })

  test("gate ON + opus-4-8 + effort ⇒ real stream input carries {type:'adaptive'}", async () => {
    process.env.QUANTA_ADAPTIVE_THINKING = "1"
    __resetRuntimeConfig()
    const llm = new RecordingThinkingLLM(OPUS)
    const out = await withTimeout(
      runAgent(adaptiveConfig(llm, "high")),
      15_000,
      "adaptive-thinking-on",
    )
    expect(out.reason).toBe("completed")
    // The loop actually sampled the model.
    expect(llm.calls).toBeGreaterThanOrEqual(1)
    // GROUND TRUTH: the thinking field the loop handed the model was adaptive,
    // with NO budget_tokens (the Opus-4.8 manual-budget-400 repair).
    const th = llm.thinkings[0]
    expect(th).toEqual({ type: "adaptive" })
    expect("budget_tokens" in (th ?? {})).toBe(false)
  })

  // ── PAIRED CONTROL (gate OFF) ─────────────────────────────────────────────
  // Same model, same effort tier, gate OFF ⇒ the loop threads the MANUAL budget
  // arm, NOT adaptive. If the loop were unconditionally adaptive (wire broken /
  // gate ignored) this assertion goes RED: the field would be {type:"adaptive"}.
  test("CONTROL: gate OFF + same model + effort ⇒ manual {type:'enabled',budget_tokens}", async () => {
    delete process.env.QUANTA_ADAPTIVE_THINKING
    __resetRuntimeConfig()
    const llm = new RecordingThinkingLLM(OPUS)
    const out = await withTimeout(
      runAgent(adaptiveConfig(llm, "high")),
      15_000,
      "adaptive-thinking-off",
    )
    expect(out.reason).toBe("completed")
    const th = llm.thinkings[0]
    // Manual arm: enabled + a concrete budget (high ⇒ 16384). NOT adaptive.
    expect(th).toEqual({ type: "enabled", budget_tokens: 16384 })
    expect((th as { type: string }).type).not.toBe("adaptive")
  })

  // ── DISCRIMINATOR (non-vacuity) ───────────────────────────────────────────
  // Gate ON but the model is NOT adaptive-capable ⇒ the loop MUST fall back to
  // the manual arm (a non-4.6 model must never receive the deprecated adaptive
  // shape and 400). Proves the ON assertion keys on the MODEL family, not the
  // knob alone.
  test("DISCRIMINATOR: gate ON + non-adaptive model ⇒ manual budget (no adaptive)", async () => {
    process.env.QUANTA_ADAPTIVE_THINKING = "1"
    __resetRuntimeConfig()
    const llm = new RecordingThinkingLLM("claude-sonnet-4-5")
    const out = await withTimeout(
      runAgent(adaptiveConfig(llm, "high")),
      15_000,
      "adaptive-thinking-nonadaptive-model",
    )
    expect(out.reason).toBe("completed")
    expect(llm.thinkings[0]).toEqual({ type: "enabled", budget_tokens: 16384 })
  })
})
