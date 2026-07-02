/**
 * StopCategory matrix tests (ADR-0063, Spec B3).
 *
 * Covers:
 *   - {@link classifyErrorReason}: every documented bucket of the matrix
 *     (rate-limit, overloaded, network, auth, bad_request, compaction thrash,
 *     unknown provider, runtime fallback). Each row asserts both `kind` and
 *     `reasonCode` so a typo in the matrix fails a single test, not the
 *     downstream consumer.
 *   - {@link completedCategory}: all four sub-kinds (normal / max_turns /
 *     empty_exhausted / malformed_exhausted) map to the documented code.
 *   - {@link interruptedCategory}: user / system cause split.
 *
 * Pure module — no clock, no IO. Tests are the contract document; adding
 * a new code MUST extend STOP_REASON_CODE and add a row here.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  STOP_REASON_CODE,
  type StopCategory,
} from "@/agent/stop-category"

describe("classifyErrorReason — matrix coverage", () => {
  test.each<[string, StopCategory["kind"], string]>([
    [
      "LLM stream failed after retries: status 429 rate_limit",
      "failed",
      STOP_REASON_CODE.PROVIDER_RATE_LIMIT,
    ],
    [
      "anthropic request failed: status 529 overloaded_error",
      "failed",
      STOP_REASON_CODE.PROVIDER_OVERLOADED,
    ],
    ["openai request failed: ECONNRESET", "failed", STOP_REASON_CODE.PROVIDER_NETWORK],
    ["anthropic request failed: status 401 unauthorized", "failed", STOP_REASON_CODE.PROVIDER_AUTH],
    [
      "openai request failed: status 400 bad_request",
      "failed",
      STOP_REASON_CODE.PROVIDER_BAD_REQUEST,
    ],
    [
      "compaction breaker tripped: no progress after 3 attempts",
      "failed",
      STOP_REASON_CODE.COMPACTION_THRASH,
    ],
    ["LLM request failed", "failed", STOP_REASON_CODE.PROVIDER_UNKNOWN],
    [
      "[empty-turn] model returned only empty responses after the budget",
      "failed",
      STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED,
    ],
    ["something totally unexpected exploded", "failed", STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR],
  ])("%s → kind=%s reasonCode=%s", (reason, kind, code) => {
    const cat = classifyErrorReason(reason)
    expect(cat.kind).toBe(kind)
    expect(cat.reasonCode).toBe(code)
  })

  test("returns hint for documented buckets, omits for unknown", () => {
    const rl = classifyErrorReason("status 429 rate limit")
    expect(rl.hint).toBeDefined()
    const fallback = classifyErrorReason("xxx")
    expect(fallback.hint).toBeUndefined()
  })
})

describe("completedCategory — all four sub-kinds", () => {
  test("normal", () => {
    expect(completedCategory("normal")).toEqual({
      kind: "completed",
      reasonCode: STOP_REASON_CODE.COMPLETED_NORMAL,
    })
  })
  test("max_turns", () => {
    expect(completedCategory("max_turns")).toEqual({
      kind: "max_turns",
      reasonCode: STOP_REASON_CODE.COMPLETED_MAX_TURNS,
      hint: "Reached the configured maxTurns limit.",
    })
  })
  test("empty_exhausted", () => {
    expect(completedCategory("empty_exhausted")).toEqual({
      kind: "completed",
      reasonCode: STOP_REASON_CODE.COMPLETED_EMPTY_EXHAUSTED,
      hint: "Stopped after repeated empty model responses.",
    })
  })
  test("malformed_exhausted", () => {
    expect(completedCategory("malformed_exhausted")).toEqual({
      kind: "completed",
      reasonCode: STOP_REASON_CODE.COMPLETED_MALFORMED_EXHAUSTED,
      hint: "Stopped after repeated malformed tool calls.",
    })
  })
  test("default arg is 'normal'", () => {
    expect(completedCategory()).toEqual(completedCategory("normal"))
  })
})

describe("interruptedCategory — user / system split", () => {
  test("user (default)", () => {
    expect(interruptedCategory()).toEqual({
      kind: "interrupted",
      reasonCode: STOP_REASON_CODE.USER_INTERRUPT,
      hint: "User interrupt.",
    })
  })
  test("system", () => {
    expect(interruptedCategory("system")).toEqual({
      kind: "interrupted",
      reasonCode: STOP_REASON_CODE.SYSTEM_ABORT,
      hint: "Run aborted by host.",
    })
  })
})

describe("STOP_REASON_CODE table is closed and namespaced", () => {
  test("every value has a dotted prefix", () => {
    for (const [k, v] of Object.entries(STOP_REASON_CODE)) {
      expect(v.includes(".")).toBe(true)
      expect(typeof k).toBe("string")
    }
  })
  test("every value is unique (no duplicates)", () => {
    const values = Object.values(STOP_REASON_CODE)
    expect(new Set(values).size).toBe(values.length)
  })
})
