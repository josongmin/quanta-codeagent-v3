import { describe, expect, test } from "bun:test"
import { toAnthropicToolChoice } from "@/llm/adapters/anthropic"
import { toOpenAIToolChoice } from "@/llm/adapters/openai"
import type { ToolChoice } from "@/llm/types"

/**
 * ADR-0079 — pin the adapter wire-shape mapping for every ToolChoice variant.
 * The unit tests here are the BYTE-IDENTICAL guard: any future refactor that
 * accidentally drops the `auto ⇒ undefined` (omit) behavior, or that maps a
 * variant to the wrong provider shape, is caught here BEFORE it hits a real
 * provider request.
 *
 * Why both adapters in one file: the mapping table is the orthogonal
 * gate's wire contract — co-locating the Anthropic and OpenAI assertions
 * makes the symmetry visible at a glance and prevents one adapter from
 * drifting without the other.
 */

const TOOLS = ["read", "edit", "test_runner"]

describe("toAnthropicToolChoice — Anthropic Messages API mapping", () => {
  test("auto ⇒ undefined (field omitted on the wire — byte-identical default)", () => {
    expect(toAnthropicToolChoice({ kind: "auto" }, TOOLS)).toBeUndefined()
  })

  test("undefined input ⇒ undefined (defensive — caller may omit)", () => {
    expect(toAnthropicToolChoice(undefined, TOOLS)).toBeUndefined()
  })

  test("any ⇒ {type:'any'}", () => {
    expect(toAnthropicToolChoice({ kind: "any" }, TOOLS)).toEqual({ type: "any" })
  })

  test("none ⇒ {type:'none'}", () => {
    expect(toAnthropicToolChoice({ kind: "none" }, TOOLS)).toEqual({ type: "none" })
  })

  test("tool with registered name ⇒ {type:'tool', name}", () => {
    expect(toAnthropicToolChoice({ kind: "tool", name: "edit" }, TOOLS)).toEqual({
      type: "tool",
      name: "edit",
    })
  })

  test("tool with UNREGISTERED name ⇒ THROWS (no silent fallback)", () => {
    // The exact failure-mode this gate exists to prevent: a stale name in a
    // ToolChoice silently being replaced with auto. We throw instead so the
    // caller MUST fix the name OR explicitly switch to auto.
    expect(() =>
      toAnthropicToolChoice({ kind: "tool", name: "ghost_tool" } as ToolChoice, TOOLS),
    ).toThrow(/unregistered tool name "ghost_tool"/)
  })
})

describe("toOpenAIToolChoice — OpenAI Chat Completions API mapping", () => {
  test("auto ⇒ undefined (field omitted on the wire — byte-identical default)", () => {
    expect(toOpenAIToolChoice({ kind: "auto" }, TOOLS)).toBeUndefined()
  })

  test("undefined input ⇒ undefined (defensive)", () => {
    expect(toOpenAIToolChoice(undefined, TOOLS)).toBeUndefined()
  })

  test("any ⇒ 'required'  (OpenAI naming for force-any-tool)", () => {
    expect(toOpenAIToolChoice({ kind: "any" }, TOOLS)).toBe("required")
  })

  test("none ⇒ 'none'", () => {
    expect(toOpenAIToolChoice({ kind: "none" }, TOOLS)).toBe("none")
  })

  test("tool with registered name ⇒ {type:'function', function:{name}}", () => {
    expect(toOpenAIToolChoice({ kind: "tool", name: "edit" }, TOOLS)).toEqual({
      type: "function",
      function: { name: "edit" },
    })
  })

  test("tool with UNREGISTERED name ⇒ THROWS (no silent fallback)", () => {
    expect(() =>
      toOpenAIToolChoice({ kind: "tool", name: "ghost_tool" } as ToolChoice, TOOLS),
    ).toThrow(/unregistered tool name "ghost_tool"/)
  })
})
