/**
 * §4.4 — TYPED agent kind: classification + boundary-validation unit hellgate.
 *
 * Pins the pure classifier (`classifyAgentType`) and the boundary validator
 * (`validateAgentType`):
 *   - normalisation (case/whitespace) of well-known kinds (CC `…_normalized`),
 *   - typed-or-string back-compat (a custom string is still valid),
 *   - DEFAULT-OFF byte-identity (enforce falsy ⇒ raw value carried untouched,
 *     never rejected),
 *   - ENFORCED miss rejection (CC `…_miss`) for an unregistered custom name.
 */

import { describe, expect, test } from "bun:test"
import {
  classifyAgentType,
  isSubagentType,
  SUBAGENT_KINDS,
  validateAgentType,
} from "../../src/subagent"

describe("§4.4 classifyAgentType — pure normalising classifier", () => {
  test("undefined / empty / whitespace ⇒ empty", () => {
    expect(classifyAgentType(undefined)).toEqual({ kind: "empty" })
    expect(classifyAgentType("")).toEqual({ kind: "empty" })
    expect(classifyAgentType("   ")).toEqual({ kind: "empty" })
    expect(classifyAgentType("\t\n ")).toEqual({ kind: "empty" })
  })

  test("every SSOT kind classifies as well-known with canonical === itself", () => {
    for (const k of SUBAGENT_KINDS) {
      expect(classifyAgentType(k)).toEqual({ kind: "well-known", canonical: k, requested: k })
    }
  })

  test("case-insensitive + whitespace-trimmed normalisation (CC …_normalized)", () => {
    const c = classifyAgentType("  PLAN  ")
    expect(c).toEqual({ kind: "well-known", canonical: "plan", requested: "  PLAN  " })
    expect(classifyAgentType("Explore")).toEqual({
      kind: "well-known",
      canonical: "explore",
      requested: "Explore",
    })
  })

  test("a non-well-known name ⇒ custom (carries raw + normalized)", () => {
    expect(classifyAgentType("MyReviewer")).toEqual({
      kind: "custom",
      requested: "MyReviewer",
      normalized: "myreviewer",
    })
  })

  test("isSubagentType is exact (no normalisation)", () => {
    expect(isSubagentType("plan")).toBe(true)
    expect(isSubagentType("PLAN")).toBe(false)
    expect(isSubagentType("custom")).toBe(false)
  })
})

describe("§4.4 validateAgentType — DEFAULT-OFF byte-identity", () => {
  test("enforce absent ⇒ raw value carried UNTOUCHED for every input (no canonicalise)", () => {
    for (const raw of [undefined, "", "Plan", "PLAN", "MyReviewer", "  spacey  "]) {
      const v = validateAgentType(raw)
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.value).toBe(raw) // raw, NOT canonicalised — byte-identical
    }
  })

  test("enforce: false behaves identically to absent (never rejects)", () => {
    const v = validateAgentType("totally-unknown", { enforce: false })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toBe("totally-unknown")
  })
})

describe("§4.4 validateAgentType — ENFORCED boundary", () => {
  test("well-known kind ⇒ accepted + CANONICALISED to SSOT spelling", () => {
    const v = validateAgentType("  PLAN ", { enforce: true })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toBe("plan")
  })

  test("empty ⇒ accepted with value undefined (the general fork)", () => {
    const v = validateAgentType("   ", { enforce: true })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toBeUndefined()
  })

  test("registered custom name (case-insensitive) ⇒ accepted, raw preserved", () => {
    const v = validateAgentType("MyReviewer", { enforce: true, knownCustom: ["myreviewer"] })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toBe("MyReviewer")
  })

  test("UNregistered custom name ⇒ REJECTED (CC …_miss) with a typed reason", () => {
    const v = validateAgentType("ghost", { enforce: true, knownCustom: ["myreviewer"] })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toContain("ghost")
      expect(v.reason).toContain("general") // lists the well-known kinds
      expect(v.classification.kind).toBe("custom")
    }
  })

  test("no knownCustom provided ⇒ any non-well-known type is a miss", () => {
    expect(validateAgentType("ghost", { enforce: true }).ok).toBe(false)
  })

  test("NO-THROW over hostile input", () => {
    expect(() => validateAgentType("\x00\uD800", { enforce: true })).not.toThrow()
    expect(() => validateAgentType(undefined, { enforce: true })).not.toThrow()
  })
})
