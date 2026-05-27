import { describe, expect, test } from "bun:test"
import { extractJsonObject, parseGroundingDecisionText } from "@/../src/apps/eval/grounding"

describe("grounding parser", () => {
  test("extracts the first balanced JSON object through prose wrappers", () => {
    const raw =
      'ignore this\n{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}\ntrailing'
    expect(extractJsonObject(raw)).toBe(
      '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}',
    )
    const parsed = parseGroundingDecisionText(raw)
    expect(parsed.error).toBeUndefined()
    expect(parsed.decision?.activeThreadId).toBe("prompt_rules")
  })

  test("returns error records instead of throwing on missing or invalid JSON", () => {
    expect(parseGroundingDecisionText("no object here")).toEqual({
      rawText: "no object here",
      error: "no JSON object in response",
      errorKind: "non_json_response",
    })

    const invalid = parseGroundingDecisionText('{"activeThreadId":1}')
    expect(invalid.decision).toBeUndefined()
    expect(invalid.error).toContain("activeThreadId must be string|null")
    expect(invalid.errorKind).toBe("invalid_decision_shape")
  })
})
