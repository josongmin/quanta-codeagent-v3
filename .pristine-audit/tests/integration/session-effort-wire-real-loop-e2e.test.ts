import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput, ThinkingConfig } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `session-effort-wire` (QUANTA_EFFORT / `/effort`).
 *
 * Prior coverage (`tests/unit/cli/effort-slash-hellgate.test.ts`) drives the
 * `/effort` slash command against a FULLY MOCKED `ctx.effort` — it proves the
 * command parses + calls `set(...)`, but never proves the resulting session
 * effort tier actually reaches the model request through the REAL loop
 * precedence (`resolveSkillTurnOverride` → `effortToTokenBudget` →
 * `thinking:{enabled,budget_tokens}` on `llm.stream(input)`).
 *
 * This drives the REAL loop with a live `sessionEffort()` accessor (the exact
 * seam a `/effort` store writes) and captures the `thinking` field OFF the real
 * stream input:
 *
 *   ON  (sessionEffort ⇒ "high")   ⇒ stream input carries {type:"enabled",budget_tokens:16384}
 *   OFF (no sessionEffort accessor) ⇒ NO thinking field (byte-identical default)
 *   OFF (sessionEffort ⇒ "default") ⇒ NO thinking field (a "default" tier is the
 *                                     provider-default, no budget → no thinking)
 *
 * The tier→budget mapping is exercised end-to-end (low→1024 … max→64000), and a
 * paired control removes the effort accessor to prove the field is gated on it.
 */

/** Records the `thinking` field of every stream input the loop hands it, then
 *  completes with a single text turn. A NON-adaptive model so the ON arm is the
 *  manual budget shape (adaptive-thinking is a separate knob/feature). */
class RecordingThinkingLLM implements LLMPort {
  readonly thinkings: (ThinkingConfig | undefined)[] = []
  calls = 0
  readonly model = "claude-sonnet-4-5"
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.thinkings.push(input.thinking)
    this.calls += 1
    yield* text("done")
  }
}

type Tier = "low" | "medium" | "high" | "max" | "default"

const effortConfig = (llm: LLMPort, effort: Tier | undefined): AgentConfig =>
  cfg({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTurns: 3,
    ...(effort !== undefined ? { sessionEffort: () => effort } : {}),
  })

const runOnce = async (effort: Tier | undefined, label: string) => {
  const llm = new RecordingThinkingLLM()
  const out = await withTimeout(runAgent(effortConfig(llm, effort)), 15_000, label)
  expect(out.reason).toBe("completed")
  expect(llm.calls).toBeGreaterThanOrEqual(1)
  return llm.thinkings[0]
}

// The knob is not env-gated in the loop seam (session effort is surface-owned),
// but adaptive-thinking IS read from runtimeConfig — pin it OFF so the ON arm is
// deterministically the manual budget shape.
describe("session-effort-wire — real runAgent loop threads the effort budget to the model", () => {
  const origAdaptive = process.env.QUANTA_ADAPTIVE_THINKING
  beforeEach(() => {
    delete process.env.QUANTA_ADAPTIVE_THINKING
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (origAdaptive === undefined) delete process.env.QUANTA_ADAPTIVE_THINKING
    else process.env.QUANTA_ADAPTIVE_THINKING = origAdaptive
    __resetRuntimeConfig()
  })

  test("ON: sessionEffort ⇒ 'high' reaches the model as {type:'enabled',budget_tokens:16384}", async () => {
    const th = await runOnce("high", "effort-high")
    expect(th).toEqual({ type: "enabled", budget_tokens: 16384 })
  })

  test("tier→budget mapping is threaded end-to-end through the real loop", async () => {
    // The full ladder — each tier's budget lands on the real stream input.
    expect(await runOnce("low", "effort-low")).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(await runOnce("medium", "effort-medium")).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    })
    expect(await runOnce("max", "effort-max")).toEqual({ type: "enabled", budget_tokens: 64000 })
  })

  // ── PAIRED CONTROL (no effort accessor) ───────────────────────────────────
  // Remove the sessionEffort accessor entirely (the byte-identical default):
  // the loop threads NO thinking field. RED if the loop injected thinking
  // unconditionally.
  test("CONTROL: no sessionEffort accessor ⇒ NO thinking field on the stream input", async () => {
    const th = await runOnce(undefined, "effort-none")
    expect(th).toBeUndefined()
  })

  // ── PAIRED CONTROL ("default" tier) ───────────────────────────────────────
  // A `/effort default` selection means "provider default, no thinking budget"
  // (the slash command's own UX contract). Through the real loop that maps to a
  // budget of `undefined` ⇒ NO thinking field. RED if "default" leaked a budget.
  test("CONTROL: sessionEffort ⇒ 'default' ⇒ NO thinking field (provider default)", async () => {
    const th = await runOnce("default", "effort-default")
    expect(th).toBeUndefined()
  })
})
