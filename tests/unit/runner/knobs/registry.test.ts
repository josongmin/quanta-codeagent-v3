/**
 * Registry — register / read / filter / reset semantics.
 *
 * The registry is module-global; each test calls `__resetRegistry` first so
 * fixtures don't leak across files. Production-mode reset is forbidden — we
 * exercise that guard at the end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRegistry, allKnobs, type Knob, knobsForSurface, registerKnob } from "@/runner/knobs"

const noopApply: Knob<boolean>["apply"] = (cfg) => cfg
const trueOrUndef = (raw: string | undefined): boolean | undefined =>
  raw === "1" ? true : undefined

const mkKnob = (id: string, surfaces: Knob["surfaces"] = ["bench"]): Knob<boolean> => ({
  id,
  envKey: `Q_${id.toUpperCase().replace(/-/g, "_")}`,
  category: "tool",
  surfaces,
  parse: trueOrUndef,
  apply: noopApply,
  describe: `knob ${id}`,
})

beforeEach(() => __resetRegistry())
afterEach(() => __resetRegistry())

describe("registerKnob", () => {
  test("registers a fresh knob", () => {
    registerKnob(mkKnob("k1"))
    expect(allKnobs().has("k1")).toBe(true)
  })

  test("collision throws", () => {
    registerKnob(mkKnob("dup"))
    expect(() => registerKnob(mkKnob("dup"))).toThrow(/collision/)
  })

  test("two distinct knobs co-exist", () => {
    registerKnob(mkKnob("a"))
    registerKnob(mkKnob("b"))
    expect(allKnobs().size).toBe(2)
  })

  test("collision message includes id", () => {
    registerKnob(mkKnob("xx"))
    try {
      registerKnob(mkKnob("xx"))
      expect(true).toBe(false)
    } catch (e) {
      expect(String(e)).toContain('"xx"')
    }
  })
})

describe("allKnobs", () => {
  test("empty after reset", () => {
    expect(allKnobs().size).toBe(0)
  })

  test("iteration order = insertion order", () => {
    registerKnob(mkKnob("first"))
    registerKnob(mkKnob("second"))
    registerKnob(mkKnob("third"))
    expect([...allKnobs().keys()]).toEqual(["first", "second", "third"])
  })

  test("returned view reflects current state", () => {
    const view = allKnobs()
    expect(view.size).toBe(0)
    registerKnob(mkKnob("z"))
    expect(view.size).toBe(1)
  })
})

describe("knobsForSurface", () => {
  test("filters by surface", () => {
    registerKnob(mkKnob("bench-only", ["bench"]))
    registerKnob(mkKnob("cli-only", ["cli"]))
    expect([...knobsForSurface("bench").keys()]).toEqual(["bench-only"])
    expect([...knobsForSurface("cli").keys()]).toEqual(["cli-only"])
  })

  test("multi-surface knob included on each", () => {
    registerKnob(mkKnob("dual", ["bench", "cli"]))
    expect(knobsForSurface("bench").has("dual")).toBe(true)
    expect(knobsForSurface("cli").has("dual")).toBe(true)
  })

  test("unknown surface returns empty", () => {
    registerKnob(mkKnob("k", ["bench"]))
    expect(knobsForSurface("ide").size).toBe(0)
  })

  test("returned map is a fresh copy (caller may freeze)", () => {
    registerKnob(mkKnob("k", ["bench"]))
    const a = knobsForSurface("bench")
    const b = knobsForSurface("bench")
    expect(a).not.toBe(b)
  })
})

describe("__resetRegistry", () => {
  test("clears registered knobs", () => {
    registerKnob(mkKnob("victim"))
    __resetRegistry()
    expect(allKnobs().size).toBe(0)
  })

  test("refuses in production", () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => __resetRegistry()).toThrow(/forbidden/)
    } finally {
      // EOPT: assigning `string | undefined` to `string` requires the delete
      // path when prev was originally unset.
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})
