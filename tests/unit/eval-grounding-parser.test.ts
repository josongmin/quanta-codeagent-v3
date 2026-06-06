import { describe, expect, test } from "bun:test"
import { extractJsonObject, parseGroundingDecisionText } from "@/../src/apps/eval/grounding"
import { parseGroundingDecisionObject } from "@/../src/apps/eval/grounding/parser"

describe("grounding parser", () => {
  test("parses an exact JSON decision object", () => {
    const raw =
      '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}'
    expect(extractJsonObject(raw)).toBe(raw)
    const parsed = parseGroundingDecisionText(raw, "exact_json")
    expect(parsed.error).toBeUndefined()
    expect(parsed.decision?.activeThreadId).toBe("prompt_rules")
    expect(parsed.structuredOutputValid).toBe(true)
  })

  test("fails closed on leading or trailing prose", () => {
    const raw =
      'ignore this\n{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}\ntrailing'
    const parsed = parseGroundingDecisionText(raw, "exact_json")
    expect(parsed.decision).toBeUndefined()
    expect(parsed.errorKind).toBe("non_json_response")
    expect(parsed.structuredOutputValid).toBe(false)
  })

  test("returns error records instead of throwing on invalid JSON or invalid shape", () => {
    expect(parseGroundingDecisionText("no object here", "exact_json")).toEqual({
      rawText: "no object here",
      structuredOutputProtocol: "exact_json",
      structuredOutputValid: false,
      error: expect.stringContaining("JSON parse"),
      errorKind: "non_json_response",
    })

    const invalid = parseGroundingDecisionText('{"activeThreadId":1}', "exact_json")
    expect(invalid.decision).toBeUndefined()
    expect(invalid.error).toContain("activeThreadId must be string|null")
    expect(invalid.errorKind).toBe("invalid_decision_shape")
    expect(invalid.structuredOutputValid).toBe(false)
  })

  test("unwraps provider structured decision objects", () => {
    const parsed = parseGroundingDecisionText(
      '{"decision":{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}}',
      "provider_structured_object",
    )
    expect(parsed.error).toBeUndefined()
    expect(parsed.decision?.referentId).toBe("prompt_rules")
    expect(parsed.structuredOutputValid).toBe(true)
  })

  // isRecord array-handling safety: a JSON array IS `typeof "object"` and
  // not null, so a naive narrower would let it through as a "record". The
  // `!Array.isArray` guard makes an array root correctly fail-closed.
  test("rejects an array root (array is not an object)", () => {
    expect(() => parseGroundingDecisionObject([])).toThrow("is not an object")
    expect(() => parseGroundingDecisionObject([{ activeThreadId: "x" }])).toThrow(
      "is not an object",
    )
  })

  test("still accepts a normal object root", () => {
    const decision = parseGroundingDecisionObject({
      activeThreadId: "prompt_rules",
      referentId: "prompt_rules",
      intent: "status_check",
      scope: "current_workstream",
      shouldClarify: false,
      confidence: "high",
    })
    expect(decision.activeThreadId).toBe("prompt_rules")
  })
})
