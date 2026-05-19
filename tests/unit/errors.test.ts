import { describe, expect, test } from "bun:test"
import {
  LLMError,
  PermissionDeniedError,
  QuantaError,
  ToolExecutionError,
  ToolInputError,
  toError,
} from "@/shared"

describe("QuantaError", () => {
  test("carries the code and message and is an Error", () => {
    const e = new QuantaError("custom_code", "something broke")
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(QuantaError)
    expect(e.code).toBe("custom_code")
    expect(e.message).toBe("something broke")
    expect(e.name).toBe("QuantaError")
  })

  test("propagates an optional cause", () => {
    const root = new Error("root")
    const e = new QuantaError("c", "wrapped", { cause: root })
    expect(e.cause).toBe(root)
  })

  test("name reflects the concrete subclass via new.target", () => {
    expect(new ToolExecutionError("x").name).toBe("ToolExecutionError")
    expect(new ToolInputError("x").name).toBe("ToolInputError")
    expect(new PermissionDeniedError("x").name).toBe("PermissionDeniedError")
    expect(new LLMError("x").name).toBe("LLMError")
  })
})

describe("subclasses", () => {
  test("ToolExecutionError: code tool_execution, instanceof chain, cause", () => {
    const cause = new Error("io")
    const e = new ToolExecutionError("failed at runtime", { cause })
    expect(e.code).toBe("tool_execution")
    expect(e.message).toBe("failed at runtime")
    expect(e.cause).toBe(cause)
    expect(e).toBeInstanceOf(ToolExecutionError)
    expect(e).toBeInstanceOf(QuantaError)
    expect(e).toBeInstanceOf(Error)
  })

  test("ToolInputError: code tool_input, no cause field", () => {
    const e = new ToolInputError("bad field: path")
    expect(e.code).toBe("tool_input")
    expect(e.message).toBe("bad field: path")
    expect(e.cause).toBeUndefined()
    expect(e).toBeInstanceOf(QuantaError)
    expect(e).toBeInstanceOf(Error)
  })

  test("PermissionDeniedError: code permission_denied", () => {
    const e = new PermissionDeniedError("blocked by policy")
    expect(e.code).toBe("permission_denied")
    expect(e.message).toBe("blocked by policy")
    expect(e).toBeInstanceOf(QuantaError)
  })

  test("LLMError: code llm, instanceof chain, cause", () => {
    const cause = new Error("429")
    const e = new LLMError("rate limited", { cause })
    expect(e.code).toBe("llm")
    expect(e.message).toBe("rate limited")
    expect(e.cause).toBe(cause)
    expect(e).toBeInstanceOf(QuantaError)
    expect(e).toBeInstanceOf(Error)
  })

  test("distinct subclasses are not instances of each other", () => {
    expect(new ToolInputError("x")).not.toBeInstanceOf(ToolExecutionError)
    expect(new LLMError("x")).not.toBeInstanceOf(PermissionDeniedError)
  })

  test("a thrown subclass is catchable as QuantaError", () => {
    let caught: unknown
    try {
      throw new ToolExecutionError("boom")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(QuantaError)
    expect((caught as QuantaError).code).toBe("tool_execution")
  })
})

describe("toError", () => {
  test("passes an Error instance through unchanged (same reference)", () => {
    const original = new Error("original")
    expect(toError(original)).toBe(original)
  })

  test("preserves QuantaError subclasses unchanged", () => {
    const e = new LLMError("llm down")
    const out = toError(e)
    expect(out).toBe(e)
    expect(out).toBeInstanceOf(LLMError)
  })

  test("wraps a raw string as its message verbatim", () => {
    const out = toError("plain failure")
    expect(out).toBeInstanceOf(Error)
    expect(out.message).toBe("plain failure")
  })

  test("JSON-stringifies non-string, non-Error values", () => {
    expect(toError({ a: 1 }).message).toBe('{"a":1}')
    expect(toError(42).message).toBe("42")
    expect(toError(null).message).toBe("null")
    expect(toError([1, "x"]).message).toBe('[1,"x"]')
  })

  test("always returns an Error instance", () => {
    expect(toError(undefined)).toBeInstanceOf(Error)
    expect(toError(true)).toBeInstanceOf(Error)
  })
})
