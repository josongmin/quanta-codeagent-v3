import { describe, expect, test } from "bun:test"
import { buildResponsesBody } from "@/llm/openai-responses-wire"
import type { StreamInput } from "@/llm/types"

/**
 * Unit tests for `QUANTA_REASONING_SUMMARY_DETAIL` — verifies that
 * `buildResponsesBody` emits `reasoning.summary = "detailed"` when
 * `reasoningSummaryDetail: "detailed"` is passed, and `"auto"` when absent.
 *
 * RED-ON-INJECTION: if the `reasoningSummaryDetail` threading is removed from
 * `buildResponsesBody`, the "detailed" test goes red (body will have `"auto"`).
 * If the default fallback is broken, the "absent" test goes red.
 */

const baseInput = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...overrides,
})

describe("buildResponsesBody — reasoningSummaryDetail", () => {
  test("summary 'detailed' when reasoningSummaryDetail='detailed'", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningSummary: true,
      reasoningSummaryDetail: "detailed",
    })
    const reasoning = body.reasoning as Record<string, unknown> | undefined
    expect(reasoning).toBeDefined()
    expect(reasoning?.summary).toBe("detailed")
  })

  test("summary 'auto' when reasoningSummaryDetail absent", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningSummary: true,
      // no reasoningSummaryDetail
    })
    const reasoning = body.reasoning as Record<string, unknown> | undefined
    expect(reasoning).toBeDefined()
    expect(reasoning?.summary).toBe("auto")
  })
})
