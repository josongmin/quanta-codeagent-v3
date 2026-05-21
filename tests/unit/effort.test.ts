import { describe, expect, test } from "bun:test"
import {
  createEffortStore,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  effortToTokenBudget,
  type EffortLevel,
  parseEffort,
  resolveEffort,
} from "@/agent/effort"

describe("EFFORT_LEVELS", () => {
  test("exactly 5 entries in documented order", () => {
    expect(EFFORT_LEVELS).toEqual(["default", "max", "high", "medium", "low"])
  })

  test("DEFAULT_EFFORT is 'default'", () => {
    expect(DEFAULT_EFFORT).toBe("default")
  })
})

describe("parseEffort", () => {
  test("undefined input returns undefined", () => {
    expect(parseEffort(undefined)).toBeUndefined()
  })

  test("empty / whitespace returns undefined", () => {
    expect(parseEffort("")).toBeUndefined()
    expect(parseEffort("   ")).toBeUndefined()
  })

  test("recognises case-insensitive named levels", () => {
    expect(parseEffort("default")).toBe("default")
    expect(parseEffort("DEFAULT")).toBe("default")
    expect(parseEffort("Max")).toBe("max")
    expect(parseEffort("high")).toBe("high")
    expect(parseEffort("medium")).toBe("medium")
    expect(parseEffort("low")).toBe("low")
  })

  test("unknown tokens return undefined", () => {
    expect(parseEffort("ultra")).toBeUndefined()
    expect(parseEffort("xtra")).toBeUndefined()
  })
})

describe("resolveEffort", () => {
  test("(undefined, undefined) ⇒ default", () => {
    expect(resolveEffort(undefined, undefined)).toBe("default")
  })

  test("session value wins when skill absent", () => {
    expect(resolveEffort("low", undefined)).toBe("low")
  })

  test("named skill effort beats session", () => {
    expect(resolveEffort("low", "max")).toBe("max")
  })

  test("numeric skill effort does NOT vote — falls through to session", () => {
    expect(resolveEffort("low", 4000)).toBe("low")
    expect(resolveEffort(undefined, 1234)).toBe("default")
  })

  test("invalid skill string falls through (defence-in-depth)", () => {
    expect(resolveEffort("low", "ultra" as unknown as EffortLevel)).toBe("low")
  })
})

describe("effortToTokenBudget", () => {
  test("default ⇒ undefined", () => {
    expect(effortToTokenBudget("default")).toBeUndefined()
  })

  test("low ⇒ 1024", () => {
    expect(effortToTokenBudget("low")).toBe(1024)
  })

  test("medium ⇒ 4096", () => {
    expect(effortToTokenBudget("medium")).toBe(4096)
  })

  test("high ⇒ 16384", () => {
    expect(effortToTokenBudget("high")).toBe(16384)
  })

  test("max ⇒ 64000", () => {
    expect(effortToTokenBudget("max")).toBe(64000)
  })

  test("every literal has a budget (exhaustiveness)", () => {
    for (const level of EFFORT_LEVELS) {
      const budget = effortToTokenBudget(level)
      if (level === "default") expect(budget).toBeUndefined()
      else expect(typeof budget).toBe("number")
    }
  })
})

describe("EffortStore", () => {
  test("default initial is DEFAULT_EFFORT", () => {
    expect(createEffortStore().get()).toBe("default")
  })

  test("explicit initial respected", () => {
    expect(createEffortStore("high").get()).toBe("high")
  })

  test("set then get round-trips", () => {
    const s = createEffortStore()
    s.set("max")
    expect(s.get()).toBe("max")
    s.set("low")
    expect(s.get()).toBe("low")
  })

  test("snapshot is an alias for get", () => {
    const s = createEffortStore("medium")
    expect(s.snapshot()).toBe(s.get())
  })
})
