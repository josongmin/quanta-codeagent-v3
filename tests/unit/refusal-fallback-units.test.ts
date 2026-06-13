/**
 * T08 — refusal-fallback UNIT coverage (round-2 structural TDD).
 *
 * Complements the end-to-end hellgate (refusal-fallback-recovery-hellgate) with
 * direct unit tests of every pure seam + the adversarial-audit edge cases:
 *   - `isRefusalStopReason` across the FULL stop-reason vocabulary.
 *   - `neutralizedRefusalTurn` shape (role-alternation marker, no refusal text).
 *   - `buildRefusalFallbackInput` OFF / ON / custom-prompt / budget thunk.
 *   - `resolveTurnAction` direct: cap, budget, OFF passthrough, non-refusal
 *     passthrough, and the TOOL-CARRYING refusal guard (must NOT neutralize a
 *     refusal that already dispatched tools — the content_filtered double-exec
 *     hole found in the adversarial audit).
 *   - `wireRefusalFallback` via `wireOptionalAgentPorts`: env on/off, prompt
 *     override, blank-prompt fallback, caller-override-precedence.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { wireOptionalAgentPorts } from "@/agent"
import {
  buildRefusalFallbackInput,
  neutralizedRefusalTurn,
  REFUSAL_NEUTRALIZED_MARKER,
  resolveTurnAction,
} from "@/agent/loop"
import { DEFAULT_REFUSAL_FALLBACK_PROMPT } from "@/agent/refusal-fallback"
import { freshRecovery } from "@/agent/loop"
import { isRefusalStopReason } from "@/llm"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { StreamSuccess } from "@/agent/loop/types"
import type { TurnState } from "@/agent/turn-context"

// ─── isRefusalStopReason — the provider-agnostic seam ────────────────────────

describe("isRefusalStopReason", () => {
  test("refusal + content_filtered ⇒ true (both vendor channels)", () => {
    expect(isRefusalStopReason("refusal")).toBe(true)
    expect(isRefusalStopReason("content_filtered")).toBe(true)
  })
  test("every non-refusal stop reason ⇒ false", () => {
    for (const s of [
      "end_turn",
      "tool_use",
      "max_tokens",
      "pause_turn",
      "guardrail_intervened", // HITL path — deliberately NOT a refusal
      "error",
      "",
      "REFUSAL", // case-sensitive
      "unknown_drift",
    ]) {
      expect(isRefusalStopReason(s)).toBe(false)
    }
  })
})

// ─── neutralizedRefusalTurn ─────────────────────────────────────────────────

describe("neutralizedRefusalTurn", () => {
  test("is an assistant turn carrying ONLY the neutral marker", () => {
    const m = neutralizedRefusalTurn()
    expect(m.role).toBe("assistant")
    expect(m.content).toEqual([{ type: "text", text: REFUSAL_NEUTRALIZED_MARKER }])
  })
})

// ─── buildRefusalFallbackInput ──────────────────────────────────────────────

const fakeLLM: LLMPort = {
  model: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    /* no-op */
  },
}

const cfgWith = (over: Partial<AgentConfig>): AgentConfig =>
  ({ llm: fakeLLM, signal: new AbortController().signal, ...over }) as AgentConfig

const stateWith = (over: Partial<TurnState> = {}): TurnState => ({ ...over }) as TurnState

describe("buildRefusalFallbackInput", () => {
  test("OFF (absent config) ⇒ undefined", () => {
    expect(buildRefusalFallbackInput(cfgWith({}), stateWith())).toBeUndefined()
  })
  test("OFF (enabled:false) ⇒ undefined", () => {
    expect(
      buildRefusalFallbackInput(cfgWith({ refusalFallback: { enabled: false } }), stateWith()),
    ).toBeUndefined()
  })
  test("ON default ⇒ enabled + built-in prompt", () => {
    const input = buildRefusalFallbackInput(
      cfgWith({ refusalFallback: { enabled: true } }),
      stateWith(),
    )
    expect(input?.enabled).toBe(true)
    expect(input?.prompt).toBe(DEFAULT_REFUSAL_FALLBACK_PROMPT)
  })
  test("ON custom prompt ⇒ that prompt", () => {
    const input = buildRefusalFallbackInput(
      cfgWith({ refusalFallback: { enabled: true, prompt: "RECONSIDER PLEASE" } }),
      stateWith(),
    )
    expect(input?.prompt).toBe("RECONSIDER PLEASE")
  })
  test("budgetOk: no taskBudget ⇒ true", () => {
    const input = buildRefusalFallbackInput(cfgWith({ refusalFallback: { enabled: true } }), stateWith())
    expect(input?.budgetOk()).toBe(true)
  })
  test("budgetOk: spend over budget ⇒ false; under ⇒ true", () => {
    const over = buildRefusalFallbackInput(
      cfgWith({ refusalFallback: { enabled: true }, taskBudget: { tokens: 10 } }),
      stateWith({ taskSpend: { tokens: 50 } }),
    )
    expect(over?.budgetOk()).toBe(false)
    const under = buildRefusalFallbackInput(
      cfgWith({ refusalFallback: { enabled: true }, taskBudget: { tokens: 100 } }),
      stateWith({ taskSpend: { tokens: 5 } }),
    )
    expect(under?.budgetOk()).toBe(true)
  })
  test("budgetOk: non-positive budget ⇒ true (no meaningful ceiling)", () => {
    const input = buildRefusalFallbackInput(
      cfgWith({ refusalFallback: { enabled: true }, taskBudget: { tokens: 0 } }),
      stateWith({ taskSpend: { tokens: 999 } }),
    )
    expect(input?.budgetOk()).toBe(true)
  })
})

// ─── resolveTurnAction direct ───────────────────────────────────────────────

const assistant = (...content: Message["content"]): StreamSuccess => ({
  message: { role: "assistant", content } as StreamSuccess["message"],
  stopReason: "refusal",
  resultBlocks: [],
})
const txt = (text: string): Message["content"][number] => ({ type: "text", text })
const tool = (id: string): Message["content"][number] => ({
  type: "tool_use",
  id,
  name: "read",
  input: {},
})

const okInput = (over: Partial<{ enabled: boolean; prompt: string; budgetOk: boolean }> = {}) => ({
  enabled: over.enabled ?? true,
  prompt: over.prompt ?? "FALLBACK",
  budgetOk: () => over.budgetOk ?? true,
})

const refusalResult = (stop: string, ...content: Message["content"]): StreamSuccess => ({
  ...assistant(...content),
  stopReason: stop,
})

describe("resolveTurnAction — T08 refusal-fallback", () => {
  test("OFF (no refusal input) ⇒ legacy refusal terminal", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(undefined, refusalResult("refusal", txt("no")), rec)
    expect(a.do).toBe("refusal")
    expect(rec.refusalFallbacks).toBe(0)
  })

  test("ON text-only refusal, cap+budget OK ⇒ refusal_fallback (consumes one slot)", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(undefined, refusalResult("refusal", txt("no")), rec, okInput())
    expect(a.do).toBe("refusal_fallback")
    if (a.do === "refusal_fallback") expect(a.text).toBe("FALLBACK")
    expect(rec.refusalFallbacks).toBe(1)
  })

  test("ON content_filtered text-only ⇒ refusal_fallback (provider-agnostic)", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(undefined, refusalResult("content_filtered", txt("x")), rec, okInput())
    expect(a.do).toBe("refusal_fallback")
  })

  test("ON but one-shot already spent ⇒ terminal refusal (rationale preserved)", () => {
    const rec = freshRecovery()
    rec.refusalFallbacks = 1
    const a = resolveTurnAction(undefined, refusalResult("refusal", txt("still no")), rec, okInput())
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("still no")
  })

  test("ON but budget exceeded ⇒ terminal refusal, NO slot consumed", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(
      undefined,
      refusalResult("refusal", txt("no")),
      rec,
      okInput({ budgetOk: false }),
    )
    expect(a.do).toBe("refusal")
    expect(rec.refusalFallbacks).toBe(0)
  })

  // ADVERSARIAL-AUDIT GUARD: a refusal-class stop that ALSO carried tool_use must
  // NOT be neutralized (the tools already dispatched in streamingTurn; content_filtered
  // does not take the in-stream short-circuit). It falls through to the legacy map.
  test("ON refusal WITH tool_use ⇒ NOT neutralized; legacy terminal refusal", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(
      undefined,
      refusalResult("refusal", txt("no"), tool("c1")),
      rec,
      okInput(),
    )
    expect(a.do).toBe("refusal") // legacy decideOnAssembled, not refusal_fallback
    expect(rec.refusalFallbacks).toBe(0)
  })

  test("ON content_filtered WITH tool_use ⇒ NOT neutralized; legacy proceed (no double-exec)", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(
      undefined,
      refusalResult("content_filtered", txt("x"), tool("c1")),
      rec,
      okInput(),
    )
    expect(a.do).toBe("proceed") // legacy path runs the dispatched tools
    expect(rec.refusalFallbacks).toBe(0)
  })

  test("ON non-refusal stop (end_turn) ⇒ legacy proceed, untouched", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(undefined, refusalResult("end_turn", txt("done")), rec, okInput())
    expect(a.do).toBe("proceed")
    expect(rec.refusalFallbacks).toBe(0)
  })

  test("stream-error path is unaffected by the refusal input", () => {
    const rec = freshRecovery()
    const a = resolveTurnAction(
      undefined,
      { error: new Error("boom"), message: "boom" },
      rec,
      okInput(),
    )
    expect(["error", "backoff", "compact"]).toContain(a.do)
  })
})

// ─── wireRefusalFallback via wireOptionalAgentPorts ─────────────────────────

const wireBase = () =>
  ({ llm: fakeLLM, signal: new AbortController().signal }) as Parameters<
    typeof wireOptionalAgentPorts
  >[0]

describe("wireOptionalAgentPorts — refusal-fallback gate", () => {
  test("env OFF ⇒ no refusalFallback (byte-identical)", () => {
    const out = wireOptionalAgentPorts(wireBase(), {})
    expect(out.refusalFallback).toBeUndefined()
  })
  test("env ON ⇒ enabled + built-in prompt", () => {
    const out = wireOptionalAgentPorts(wireBase(), { QUANTA_REFUSAL_FALLBACK: "1" })
    expect(out.refusalFallback).toEqual({ enabled: true, prompt: DEFAULT_REFUSAL_FALLBACK_PROMPT })
  })
  test("env ON + custom prompt ⇒ that prompt", () => {
    const out = wireOptionalAgentPorts(wireBase(), {
      QUANTA_REFUSAL_FALLBACK: "on",
      QUANTA_REFUSAL_FALLBACK_PROMPT: "PLEASE RECONSIDER",
    })
    expect(out.refusalFallback?.prompt).toBe("PLEASE RECONSIDER")
  })
  test("env ON + blank prompt ⇒ built-in default", () => {
    const out = wireOptionalAgentPorts(wireBase(), {
      QUANTA_REFUSAL_FALLBACK: "1",
      QUANTA_REFUSAL_FALLBACK_PROMPT: "   ",
    })
    expect(out.refusalFallback?.prompt).toBe(DEFAULT_REFUSAL_FALLBACK_PROMPT)
  })
  test("caller-override-precedence: pre-set config survives even with env ON", () => {
    const base = { ...wireBase(), refusalFallback: { enabled: false, prompt: "MINE" } }
    const out = wireOptionalAgentPorts(base, { QUANTA_REFUSAL_FALLBACK: "1" })
    expect(out.refusalFallback).toEqual({ enabled: false, prompt: "MINE" })
  })
})
