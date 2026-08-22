import { describe, expect, test } from "bun:test"
import {
  attrs,
  InvalidAttrValueError,
  mergeAttrs,
  permissionAttrs,
  toolAttrs,
  turnAttrs,
} from "@/observability/attrs"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability/vocabulary"

describe("attrs() — happy path", () => {
  test("builds a frozen object from valid keys", () => {
    const a = attrs({
      [QUANTA_ATTRS.turn.id]: "t-1",
      [QUANTA_ATTRS.turn.durationMs]: 42,
      [QUANTA_ATTRS.turn.interrupted]: false,
    })
    expect(a[QUANTA_ATTRS.turn.id]).toBe("t-1")
    expect(a[QUANTA_ATTRS.turn.durationMs]).toBe(42)
    expect(a[QUANTA_ATTRS.turn.interrupted]).toBe(false)
    expect(Object.isFrozen(a)).toBe(true)
  })

  test("accepts homogeneous string array", () => {
    const a = attrs({
      [GEN_AI_ATTRS.response.finishReason]: ["stop", "length"] as const,
    })
    expect(a[GEN_AI_ATTRS.response.finishReason]).toEqual(["stop", "length"])
  })

  test("accepts empty input and yields a frozen empty object", () => {
    const a = attrs({})
    expect(Object.keys(a).length).toBe(0)
    expect(Object.isFrozen(a)).toBe(true)
  })

  test("skips explicit undefined values without throwing", () => {
    const a = attrs({
      [QUANTA_ATTRS.turn.id]: "t-2",
      [QUANTA_ATTRS.turn.durationMs]: undefined,
    })
    expect(a[QUANTA_ATTRS.turn.id]).toBe("t-2")
    expect(QUANTA_ATTRS.turn.durationMs in a).toBe(false)
  })

  test("accepts gen_ai.* keys side-by-side with quanta.* keys", () => {
    const a = attrs({
      [QUANTA_ATTRS.turn.id]: "t-3",
      [GEN_AI_ATTRS.usage.inputTokens]: 100,
      [GEN_AI_ATTRS.usage.outputTokens]: 200,
      [GEN_AI_ATTRS.system]: "anthropic",
    })
    expect(Object.keys(a).length).toBe(4)
  })
})

describe("attrs() — validation failures", () => {
  test("throws InvalidAttrValueError for unknown key (escaped via cast)", () => {
    expect(() => attrs({ ["quanta.bogus.key" as never]: "x" })).toThrowError(InvalidAttrValueError)
  })

  test("error carries key / value / reason", () => {
    try {
      attrs({ ["quanta.bogus.key" as never]: "x" })
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAttrValueError)
      const err = e as InvalidAttrValueError
      expect(err.key).toBe("quanta.bogus.key")
      expect(err.value).toBe("x")
      expect(err.reason).toContain("canonical vocabulary")
      expect(err.code).toBe("invalid_attr_value")
      expect(err.name).toBe("InvalidAttrValueError")
    }
  })

  test("rejects null value", () => {
    expect(() => attrs({ [QUANTA_ATTRS.turn.id]: null as never })).toThrowError(
      InvalidAttrValueError,
    )
  })

  test("rejects NaN", () => {
    expect(() => attrs({ [QUANTA_ATTRS.turn.durationMs]: Number.NaN })).toThrowError(
      InvalidAttrValueError,
    )
  })

  test("rejects Infinity", () => {
    expect(() => attrs({ [QUANTA_ATTRS.turn.durationMs]: Number.POSITIVE_INFINITY })).toThrowError(
      InvalidAttrValueError,
    )
  })

  test("rejects object value", () => {
    expect(() => attrs({ [QUANTA_ATTRS.turn.id]: { x: 1 } as never })).toThrowError(
      InvalidAttrValueError,
    )
  })

  test("rejects function value", () => {
    expect(() => attrs({ [QUANTA_ATTRS.turn.id]: (() => "x") as never })).toThrowError(
      InvalidAttrValueError,
    )
  })

  test("rejects mixed-type arrays", () => {
    expect(() =>
      attrs({
        [GEN_AI_ATTRS.response.finishReason]: ["stop", 1] as never,
      }),
    ).toThrowError(InvalidAttrValueError)
  })

  test("rejects array containing NaN", () => {
    expect(() =>
      attrs({
        [QUANTA_ATTRS.turn.durationMs]: [1, Number.NaN] as never,
      }),
    ).toThrowError(InvalidAttrValueError)
  })

  test("accepts empty array (homogeneous by vacuous truth)", () => {
    const a = attrs({
      [GEN_AI_ATTRS.response.finishReason]: [] as readonly string[],
    })
    expect(a[GEN_AI_ATTRS.response.finishReason]).toEqual([])
  })
})

describe("mergeAttrs()", () => {
  test("merges two bags, later wins on collision", () => {
    const a = attrs({ [QUANTA_ATTRS.turn.id]: "first" })
    const b = attrs({ [QUANTA_ATTRS.turn.id]: "second" })
    const merged = mergeAttrs(a, b)
    expect(merged[QUANTA_ATTRS.turn.id]).toBe("second")
  })

  test("preserves non-colliding keys from both", () => {
    const a = attrs({ [QUANTA_ATTRS.turn.id]: "t" })
    const b = attrs({ [QUANTA_ATTRS.turn.durationMs]: 5 })
    const merged = mergeAttrs(a, b)
    expect(merged[QUANTA_ATTRS.turn.id]).toBe("t")
    expect(merged[QUANTA_ATTRS.turn.durationMs]).toBe(5)
  })

  test("handles zero, one, and many inputs", () => {
    expect(Object.keys(mergeAttrs()).length).toBe(0)
    const a = attrs({ [QUANTA_ATTRS.turn.id]: "x" })
    expect(mergeAttrs(a)[QUANTA_ATTRS.turn.id]).toBe("x")
    const b = attrs({ [QUANTA_ATTRS.turn.kind]: "explore" })
    const c = attrs({ [QUANTA_ATTRS.turn.interrupted]: true })
    const merged = mergeAttrs(a, b, c)
    expect(Object.keys(merged).length).toBe(3)
  })

  test("merge result is frozen", () => {
    const merged = mergeAttrs(attrs({ [QUANTA_ATTRS.turn.id]: "x" }))
    expect(Object.isFrozen(merged)).toBe(true)
  })

  test("left-to-right ordering — three-way collision resolved to rightmost", () => {
    const a = attrs({ [QUANTA_ATTRS.turn.id]: "a" })
    const b = attrs({ [QUANTA_ATTRS.turn.id]: "b" })
    const c = attrs({ [QUANTA_ATTRS.turn.id]: "c" })
    expect(mergeAttrs(a, b, c)[QUANTA_ATTRS.turn.id]).toBe("c")
  })
})

describe("turnAttrs()", () => {
  test("builds minimal turn bag", () => {
    const a = turnAttrs({ turnId: "T1", kind: "explore" })
    expect(a[QUANTA_ATTRS.turn.id]).toBe("T1")
    expect(a[QUANTA_ATTRS.turn.kind]).toBe("explore")
    expect(QUANTA_ATTRS.turn.durationMs in a).toBe(false)
  })

  test("includes durationMs when provided", () => {
    const a = turnAttrs({ turnId: "T2", kind: "compact", durationMs: 1234 })
    expect(a[QUANTA_ATTRS.turn.durationMs]).toBe(1234)
  })

  test("result is frozen", () => {
    expect(Object.isFrozen(turnAttrs({ turnId: "T", kind: "k" }))).toBe(true)
  })
})

describe("toolAttrs()", () => {
  test("builds tool bag with success status", () => {
    const a = toolAttrs({ name: "bash", callId: "c1", status: "success" })
    expect(a[QUANTA_ATTRS.tool.name]).toBe("bash")
    expect(a[QUANTA_ATTRS.tool.callId]).toBe("c1")
    expect(a[QUANTA_ATTRS.tool.status]).toBe("success")
  })

  test("accepts each ToolStatus literal", () => {
    for (const status of ["success", "error", "blocked"] as const) {
      const a = toolAttrs({ name: "n", callId: "c", status })
      expect(a[QUANTA_ATTRS.tool.status]).toBe(status)
    }
  })

  test("durationMs threads through", () => {
    const a = toolAttrs({
      name: "edit",
      callId: "c2",
      status: "error",
      durationMs: 7,
    })
    expect(a[QUANTA_ATTRS.tool.durationMs]).toBe(7)
  })
})

describe("permissionAttrs()", () => {
  test("builds permission bag (ADR-0029)", () => {
    const a = permissionAttrs({
      reviewerTier: "guardian_subagent",
      outcome: "guardian_approved",
      riskLevel: "medium",
    })
    expect(a[QUANTA_ATTRS.permission.reviewerTier]).toBe("guardian_subagent")
    expect(a[QUANTA_ATTRS.permission.outcome]).toBe("guardian_approved")
    expect(a[QUANTA_ATTRS.permission.riskLevel]).toBe("medium")
  })

  test("accepts each RiskLevel literal", () => {
    for (const riskLevel of ["low", "medium", "high"] as const) {
      const a = permissionAttrs({
        reviewerTier: "user",
        outcome: "user_approved",
        riskLevel,
      })
      expect(a[QUANTA_ATTRS.permission.riskLevel]).toBe(riskLevel)
    }
  })
})
