/**
 * PDP first-decider — `decideFloor` (the SECURITY FLOOR), ticket P2-T3.
 * Pure-function hellgate: the exhaustive truth table that splits "inherently
 * sensitive" (universal floor) from "needs-sandbox" / unclassified (defer) — the
 * split that un-blocks always-confirm secure-by-default without gating bash.
 */
import { describe, expect, test } from "bun:test"
import { decideFloor, inferToolTier, type ToolCapability } from "@/permission"
import type { HITLTier } from "@/shared"

const ALL_TIERS: HITLTier[] = ["none", "pre-approval-ok", "always-confirm", "hand-off-required"]

describe("PDP decideFloor — the security floor split [P2-T3]", () => {
  test("ONLY (always-confirm × sensitive) promotes to the universal floor", () => {
    const cap: ToolCapability = { confirm: "sensitive" }
    expect(decideFloor({ tier: "always-confirm", capability: cap })).toBe("universal-floor")
  })

  test("always-confirm with needs-sandbox DEFERS (bash without a profile is not gated)", () => {
    expect(decideFloor({ tier: "always-confirm", capability: { confirm: "needs-sandbox" } })).toBe(
      "defer",
    )
  })

  test("always-confirm with NO capability DEFERS (the inferToolTier catch-all stays mode-policy)", () => {
    expect(decideFloor({ tier: "always-confirm", capability: undefined })).toBe("defer")
  })

  test("a sensitive capability does NOT promote a non-always-confirm tier", () => {
    const cap: ToolCapability = { confirm: "sensitive" }
    expect(decideFloor({ tier: "pre-approval-ok", capability: cap })).toBe("defer")
    expect(decideFloor({ tier: "none", capability: cap })).toBe("defer")
    // hand-off-required is handled by its own upstream floor, NOT promoted here.
    expect(decideFloor({ tier: "hand-off-required", capability: cap })).toBe("defer")
  })

  // EXHAUSTIVE truth table — the only "universal-floor" cell is (always-confirm,
  // sensitive). Everything else defers. A regression that widens the floor (e.g.
  // promoting unclassified always-confirm) flips a cell RED.
  test("exhaustive: universal-floor iff tier=always-confirm AND confirm=sensitive", () => {
    const confirms: Array<ToolCapability["confirm"] | "no-cap"> = [
      "sensitive",
      "needs-sandbox",
      undefined,
      "no-cap",
    ]
    for (const tier of ALL_TIERS) {
      for (const c of confirms) {
        const capability = c === "no-cap" ? undefined : ({ confirm: c } as ToolCapability)
        const expected =
          tier === "always-confirm" && c === "sensitive" ? "universal-floor" : "defer"
        expect(decideFloor({ tier, capability })).toBe(expected)
      }
    }
  })
})

// capability is the SSOT for the confirm axis — `inferToolTier` DERIVES the tier
// from it, so a tool declares ONE thing (capability) not a redundant hitlTier.
describe("inferToolTier — capability drives the tier (SSOT) [P2-T3]", () => {
  const tool = (over: {
    readOnly?: boolean
    hitlTier?: HITLTier
    capability?: ToolCapability
  }) => ({
    isReadOnly: () => over.readOnly ?? false,
    ...(over.hitlTier !== undefined ? { hitlTier: () => over.hitlTier as HITLTier } : {}),
    ...(over.capability !== undefined
      ? { capability: () => over.capability as ToolCapability }
      : {}),
  })

  test("capability sensitive ⇒ always-confirm tier even when the tool is read-only", () => {
    // Without the SSOT, a read-only tool would infer "none" and decideFloor would
    // never see always-confirm — a silent no-floor. capability must drive it.
    expect(inferToolTier(tool({ readOnly: true, capability: { confirm: "sensitive" } }), {})).toBe(
      "always-confirm",
    )
  })

  test("capability needs-sandbox ⇒ always-confirm tier (asks when no profile / hitl on)", () => {
    expect(
      inferToolTier(tool({ readOnly: false, capability: { confirm: "needs-sandbox" } }), {}),
    ).toBe("always-confirm")
  })

  test("an explicit hand-off-required hitlTier is NEVER downgraded by a capability", () => {
    expect(
      inferToolTier(
        tool({ hitlTier: "hand-off-required", capability: { confirm: "sensitive" } }),
        {},
      ),
    ).toBe("hand-off-required")
  })

  test("no capability ⇒ legacy behavior (explicit hitlTier, else readOnly default)", () => {
    expect(inferToolTier(tool({ readOnly: true }), {})).toBe("none")
    expect(inferToolTier(tool({ readOnly: false }), {})).toBe("always-confirm")
    expect(inferToolTier(tool({ hitlTier: "pre-approval-ok" }), {})).toBe("pre-approval-ok")
  })
})
