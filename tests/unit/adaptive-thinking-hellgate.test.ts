/**
 * Hellgate — adaptive thinking (`thinking:{type:"adaptive"}`) for the Anthropic
 * adapter (RFC docs/plans/jun-6-adaptive-thinking.md).
 *
 * Proves:
 *  1. KNOB OFF (default) ⇒ BYTE-IDENTICAL manual `{type:"enabled",budget_tokens}`
 *     for every model — including the default model `claude-opus-4-8`.
 *  2. KNOB ON + adaptive-capable family ⇒ `{type:"adaptive"}` with NO
 *     `budget_tokens` (repairs the Opus-4.8 / 4.7 manual-budget 400).
 *  3. KNOB ON + older/unknown model ⇒ fallback to manual budget (NO adaptive,
 *     NO 400 shape).
 *  4. No-thinking turn (budget 0) ⇒ no `thinking` field at all, knob on or off.
 *  5. Family normalization (cloud/date/@/-vN slugs) recognizes capability.
 *  6. The codec emits the exact wire JSON for each arm and round-trips without
 *     throwing.
 *  7. Provider isolation — adaptive never leaks into the OpenAI Responses wire;
 *     H15 reasoning-carryover still assembles (disjoint path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ResolvedTurnOverride } from "@/agent/loop/skill-gate"
import { applyEffortClassifierFloor } from "@/agent/loop/skill-gate"
import {
  ADAPTIVE_THINKING_FAMILIES,
  type LLMPort,
  supportsAdaptiveThinking,
  type ThinkingConfig,
} from "@/llm"
import { buildAnthropicMessagesRequest } from "@/llm/anthropic-messages-codec"
import { buildResponsesBody } from "@/llm/openai-responses-wire"
import type { StreamInput } from "@/llm/types"
import { __resetRuntimeConfig } from "@/shared"

const KNOB = "QUANTA_ADAPTIVE_THINKING"
const origKnob = process.env[KNOB]

const setKnob = (on: boolean): void => {
  if (on) process.env[KNOB] = "1"
  else delete process.env[KNOB]
  __resetRuntimeConfig()
}

beforeEach(() => {
  delete process.env[KNOB]
  __resetRuntimeConfig()
})
afterEach(() => {
  if (origKnob === undefined) delete process.env[KNOB]
  else process.env[KNOB] = origKnob
  __resetRuntimeConfig()
})

/** Minimal LLMPort double — only `.model` is read by the producer. */
const portFor = (model: string | undefined): LLMPort =>
  ({ model, stream: () => Promise.reject(new Error("unused")) }) as unknown as LLMPort

const resolved = (model: string | undefined, budgetTokens?: number): ResolvedTurnOverride => ({
  llm: portFor(model),
  budgetTokens,
  explicitOff: false,
})

const HIGH = 16384

describe("supportsAdaptiveThinking — family gate (pure)", () => {
  test("4.6+ families are adaptive-capable", () => {
    for (const m of ADAPTIVE_THINKING_FAMILIES) expect(supportsAdaptiveThinking(m)).toBe(true)
    expect(supportsAdaptiveThinking("claude-opus-4-8")).toBe(true)
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true)
  })
  test("older / unknown / absent slugs are NOT adaptive (fail-safe)", () => {
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false)
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false)
    expect(supportsAdaptiveThinking("claude-3-7-sonnet-20250219")).toBe(false)
    expect(supportsAdaptiveThinking("gpt-5")).toBe(false)
    expect(supportsAdaptiveThinking("garbage-model-x")).toBe(false)
    expect(supportsAdaptiveThinking(undefined)).toBe(false)
  })
  test("cloud / date / @ / -vN slugs normalize to the capable family", () => {
    expect(supportsAdaptiveThinking("anthropic.claude-opus-4-8-v1:0")).toBe(true)
    expect(supportsAdaptiveThinking("claude-opus-4-6@20251101")).toBe(true)
    expect(supportsAdaptiveThinking("claude-opus-4-8-20250101")).toBe(true)
    // older normalized family stays non-adaptive even with a cloud prefix
    expect(supportsAdaptiveThinking("anthropic.claude-sonnet-4-5-v1:0")).toBe(false)
  })
  test("haiku-4-5 is on the 1h-cache set but deliberately NOT adaptive", () => {
    expect(ADAPTIVE_THINKING_FAMILIES.has("claude-haiku-4-5")).toBe(false)
  })
})

describe("applyEffortClassifierFloor — producer decision", () => {
  test("KNOB OFF: byte-identical manual budget on the default model (opus-4-8)", () => {
    setKnob(false)
    const out = applyEffortClassifierFloor(resolved("claude-opus-4-8", HIGH), undefined)
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: HIGH })
  })

  test("KNOB ON + opus-4-8 ⇒ {type:'adaptive'} with NO budget_tokens", () => {
    setKnob(true)
    const out = applyEffortClassifierFloor(resolved("claude-opus-4-8", HIGH), undefined)
    expect(out.thinking).toEqual({ type: "adaptive" })
    expect((out.thinking as { budget_tokens?: number }).budget_tokens).toBeUndefined()
    expect("budget_tokens" in (out.thinking ?? {})).toBe(false)
  })

  test("KNOB ON across every adaptive-capable family ⇒ adaptive", () => {
    setKnob(true)
    for (const m of [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]) {
      const out = applyEffortClassifierFloor(resolved(m, HIGH), undefined)
      expect(out.thinking).toEqual({ type: "adaptive" })
    }
  })

  test("KNOB ON + older models ⇒ manual fallback (no 400 shape, no adaptive)", () => {
    setKnob(true)
    for (const m of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-7-sonnet-20250219"]) {
      const out = applyEffortClassifierFloor(resolved(m, HIGH), undefined)
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: HIGH })
    }
  })

  test("KNOB ON + unknown/absent model ⇒ manual fallback (fail-safe)", () => {
    setKnob(true)
    expect(applyEffortClassifierFloor(resolved("garbage-x", HIGH), undefined).thinking).toEqual({
      type: "enabled",
      budget_tokens: HIGH,
    })
    expect(applyEffortClassifierFloor(resolved(undefined, HIGH), undefined).thinking).toEqual({
      type: "enabled",
      budget_tokens: HIGH,
    })
  })

  test("no-think turn (budget 0) ⇒ no thinking field, knob on OR off, any model", () => {
    for (const on of [false, true]) {
      setKnob(on)
      for (const m of ["claude-opus-4-8", "claude-sonnet-4-5", undefined]) {
        const out = applyEffortClassifierFloor(resolved(m, 0), undefined)
        expect(out.thinking).toBeUndefined()
      }
    }
  })

  test("explicitOff ⇒ no thinking field (unchanged), knob on", () => {
    setKnob(true)
    const out = applyEffortClassifierFloor(
      { llm: portFor("claude-opus-4-8"), explicitOff: true },
      undefined,
    )
    expect(out.thinking).toBeUndefined()
  })

  test("cloud slug + knob on ⇒ adaptive (normalized family match)", () => {
    setKnob(true)
    const out = applyEffortClassifierFloor(
      resolved("anthropic.claude-opus-4-8-v1:0", HIGH),
      undefined,
    )
    expect(out.thinking).toEqual({ type: "adaptive" })
  })
})

const baseInput = (thinking?: ThinkingConfig): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...(thinking !== undefined ? { thinking } : {}),
})

describe("codec — anthropic wire shaping", () => {
  test("enabled arm → wire carries {type:'enabled',budget_tokens}", () => {
    const req = buildAnthropicMessagesRequest(
      "claude-sonnet-4-5",
      1000,
      baseInput({ type: "enabled", budget_tokens: HIGH }),
    )
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: HIGH })
  })

  test("adaptive arm → wire carries {type:'adaptive'} and NO budget_tokens", () => {
    const req = buildAnthropicMessagesRequest(
      "claude-opus-4-8",
      1000,
      baseInput({ type: "adaptive" }),
    )
    expect(req.thinking).toEqual({ type: "adaptive" } as never)
    expect("budget_tokens" in (req.thinking ?? {})).toBe(false)
  })

  test("absent thinking → no thinking key on the wire (byte-identical no-think)", () => {
    const req = buildAnthropicMessagesRequest("claude-opus-4-8", 1000, baseInput())
    expect("thinking" in req).toBe(false)
  })

  test("end-to-end: producer adaptive → codec adaptive wire (no throw)", () => {
    setKnob(true)
    const out = applyEffortClassifierFloor(resolved("claude-opus-4-8", HIGH), undefined)
    const req = buildAnthropicMessagesRequest("claude-opus-4-8", 1000, baseInput(out.thinking))
    expect(req.thinking).toEqual({ type: "adaptive" } as never)
  })
})

describe("provider isolation — adaptive never leaks into OpenAI Responses", () => {
  test("Responses body with adaptive present is identical to thinking-absent", () => {
    const withAdaptive = buildResponsesBody(baseInput({ type: "adaptive" }), "gpt-5")
    const without = buildResponsesBody(baseInput(), "gpt-5")
    expect("thinking" in withAdaptive).toBe(false)
    expect(withAdaptive).toEqual(without)
  })

  test("H15 reasoning-carryover still assembles on the disjoint Responses path", () => {
    const priorReasoningItems = [
      { type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] },
    ]
    const body = buildResponsesBody(baseInput({ type: "adaptive" }), "gpt-5", {
      reasoningCarryover: true,
      priorReasoningItems,
    })
    // carry-over re-emits the prior reasoning item AND asks for encrypted content
    expect((body.input as unknown[])[0]).toEqual(priorReasoningItems[0])
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    // and still no `thinking` key (Anthropic-only field never reaches Responses)
    expect("thinking" in body).toBe(false)
  })
})
