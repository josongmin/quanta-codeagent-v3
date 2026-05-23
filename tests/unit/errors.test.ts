import { describe, expect, test } from "bun:test"
import {
  errMessage,
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

describe("errMessage", () => {
  // Pinned: matches the legacy inline pattern `e instanceof Error ? e.message
  // : String(e)` byte-identically. A regression here would silently change
  // 70+ migrated call sites' log/error text shape. Includes a regression
  // guard for the infinite-recursion bug introduced when a sed pass replaced
  // the function body with `errMessage(e)` and self-resolved against itself.
  test("Error → e.message (verbatim)", () => {
    expect(errMessage(new Error("boom"))).toBe("boom")
    class Custom extends Error {}
    expect(errMessage(new Custom("sub"))).toBe("sub")
  })

  test("non-Error → String(e) (NOT JSON-stringify — that is toError's policy)", () => {
    expect(errMessage("plain")).toBe("plain")
    expect(errMessage(42)).toBe("42")
    expect(errMessage(null)).toBe("null")
    expect(errMessage(undefined)).toBe("undefined")
    expect(errMessage(true)).toBe("true")
    // Object stays "[object Object]" — matching legacy String(e) behavior so
    // call-site migration is byte-identical. (toError would JSON-stringify.)
    expect(errMessage({ a: 1 })).toBe("[object Object]")
  })

  test("regression: does NOT recurse on itself (returns synchronously)", () => {
    // If errMessage were ever `(e) => errMessage(e)` (the sed-self-match bug
    // that landed once and was hand-fixed) this resolves nothing and the
    // stack overflows. A passing assertion below proves termination.
    const start = Date.now()
    const out = errMessage(new Error("x"))
    expect(out).toBe("x")
    expect(Date.now() - start).toBeLessThan(50) // conservative: ms, not seconds
  })
})
