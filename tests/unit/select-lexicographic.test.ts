import { describe, expect, it } from "bun:test"
import {
  compareLexTiers,
  type LexCandidate,
  type LexTiers,
  selectLexicographic,
} from "@/agent/verification-bundle/select-lexicographic"

/**
 * A neutral baseline tier set: zero proof, zero contracts, lowest family, and a
 * deliberately LARGE patch (many files/lines/defs/new files). Overriding a single
 * authority tier upward on one candidate proves that tier dominates in isolation;
 * overriding minimality downward proves minimality is only a late tie-break.
 */
const baseTiers: LexTiers = {
  proofStrength: 0,
  executedKeepGreen: 0,
  requiredContractsSatisfied: 0,
  contractsSatisfied: 0,
  familyRank: 0,
  sourceFiles: 9,
  addedLines: 900,
  newDefs: 9,
  newFiles: 9,
  order: 0,
}

const tiers = (over: Partial<LexTiers>): LexTiers => ({ ...baseTiers, ...over })

/** A maximally small patch on every minimality tier (the cheapest possible loser). */
const tinyOver: Partial<LexTiers> = {
  sourceFiles: 1,
  addedLines: 1,
  newDefs: 0,
  newFiles: 0,
}

const cand = (id: string, over: Partial<LexTiers>, admissible = true): LexCandidate => ({
  id,
  admissible,
  tiers: tiers({ ...over, order: over.order ?? 0 }),
})

describe("compareLexTiers (direct comparator)", () => {
  it("identical tiers compare equal (0)", () => {
    expect(compareLexTiers(baseTiers, baseTiers)).toBe(0)
    expect(compareLexTiers(tiers({}), tiers({}))).toBe(0)
  })

  it("is sign-symmetric: compare(a,b) and compare(b,a) have opposite signs", () => {
    const a = tiers({ proofStrength: 0.8 })
    const b = tiers({ proofStrength: 0.2 })
    expect(compareLexTiers(a, b)).toBeLessThan(0)
    expect(compareLexTiers(b, a)).toBeGreaterThan(0)
  })

  it("DESC tiers: higher proofStrength is better (negative)", () => {
    expect(compareLexTiers(tiers({ proofStrength: 0.9 }), tiers({ proofStrength: 0.1 }))).toBeLessThan(0)
  })

  it("ASC tiers: smaller sourceFiles is better (negative) when earlier tiers tie", () => {
    expect(compareLexTiers(tiers({ sourceFiles: 1 }), tiers({ sourceFiles: 5 }))).toBeLessThan(0)
  })

  it("an earlier tier is NEVER overturned by a later one", () => {
    // `a` is WORSE on proof (the highest tier) but BETTER on every later tier.
    const a = tiers({ proofStrength: 0.1, ...tinyOver, contractsSatisfied: 0, familyRank: 0 })
    const b = tiers({
      proofStrength: 0.2,
      contractsSatisfied: 99,
      requiredContractsSatisfied: 99,
      familyRank: 99,
      sourceFiles: 50,
      addedLines: 5000,
      newDefs: 50,
      newFiles: 50,
    })
    // proof decides first; `a` must LOSE despite winning every later tier.
    expect(compareLexTiers(a, b)).toBeGreaterThan(0)
    // mutation teeth: if proof were summed with the later tiers `a` would win — it must not.
  })
})

describe("selectLexicographic — each authority tier independently dominates size", () => {
  it("higher proofStrength beats a smaller candidate (proof dominates size)", () => {
    const proven = cand("proven", { proofStrength: 0.6 }) // large patch
    const small = cand("small", { proofStrength: 0, ...tinyOver }) // tiny patch, no proof
    expect(selectLexicographic([small, proven])).toBe("proven")
    expect(selectLexicographic([proven, small])).toBe("proven")
  })

  it("with proof tied, an executed keep-green suite beats a smaller candidate", () => {
    const green = cand("green", { proofStrength: 0.5, executedKeepGreen: 1 })
    const small = cand("small", { proofStrength: 0.5, executedKeepGreen: 0, ...tinyOver })
    expect(selectLexicographic([small, green])).toBe("green")
  })

  it("with proof tied, more requiredContractsSatisfied beats a smaller candidate (contract dominates size)", () => {
    const contract = cand("contract", { proofStrength: 0.5, requiredContractsSatisfied: 2 })
    const small = cand("small", {
      proofStrength: 0.5,
      requiredContractsSatisfied: 0,
      ...tinyOver,
    })
    expect(selectLexicographic([small, contract])).toBe("contract")
  })

  it("with proof+required tied, more contractsSatisfied (any strength) beats smaller", () => {
    const contract = cand("contract", { proofStrength: 0.5, contractsSatisfied: 3 })
    const small = cand("small", { proofStrength: 0.5, contractsSatisfied: 0, ...tinyOver })
    expect(selectLexicographic([small, contract])).toBe("contract")
  })

  it("with proof+contracts tied, higher familyRank (root-owner) beats a smaller symptom-owner (family dominates size)", () => {
    const root = cand("root", { proofStrength: 0.5, contractsSatisfied: 1, familyRank: 3 })
    const symptom = cand("symptom", {
      proofStrength: 0.5,
      contractsSatisfied: 1,
      familyRank: 0,
      ...tinyOver,
    })
    expect(selectLexicographic([symptom, root])).toBe("root")
  })
})

describe("selectLexicographic — minimality only when authority tiers all tie", () => {
  it("smaller sourceFiles wins only when proof, contracts, family ALL tied", () => {
    const shared = { proofStrength: 0.5, contractsSatisfied: 2, requiredContractsSatisfied: 1, familyRank: 2 }
    const big = cand("big", { ...shared, sourceFiles: 5 })
    const small = cand("small", { ...shared, sourceFiles: 1 })
    expect(selectLexicographic([big, small])).toBe("small")
  })

  it("with everything above tied, smaller addedLines then newDefs then newFiles decide in order", () => {
    const shared = { proofStrength: 0.4, contractsSatisfied: 1, familyRank: 1, sourceFiles: 2 }
    // tie on sourceFiles -> addedLines decides
    expect(
      selectLexicographic([
        cand("more", { ...shared, addedLines: 50 }),
        cand("fewer", { ...shared, addedLines: 10 }),
      ]),
    ).toBe("fewer")
    // tie up to addedLines -> newDefs decides
    expect(
      selectLexicographic([
        cand("moredefs", { ...shared, addedLines: 10, newDefs: 3 }),
        cand("fewerdefs", { ...shared, addedLines: 10, newDefs: 0 }),
      ]),
    ).toBe("fewerdefs")
    // tie up to newDefs -> newFiles decides
    expect(
      selectLexicographic([
        cand("morefiles", { ...shared, addedLines: 10, newDefs: 0, newFiles: 2 }),
        cand("nofiles", { ...shared, addedLines: 10, newDefs: 0, newFiles: 0 }),
      ]),
    ).toBe("nofiles")
  })

  it("a smaller patch CANNOT beat a stronger-proof patch (the whole point)", () => {
    const stronger = cand("stronger", { proofStrength: 0.9, sourceFiles: 8, addedLines: 800, newDefs: 8, newFiles: 8 })
    const tiny = cand("tiny", { proofStrength: 0.1, ...tinyOver })
    expect(selectLexicographic([tiny, stronger])).toBe("stronger")
  })
})

describe("selectLexicographic — deterministic tie-break and admissibility", () => {
  it("full tie on every authority+minimality tier → lowest order wins", () => {
    const a = cand("a", { proofStrength: 0.5, order: 2 })
    const b = cand("b", { proofStrength: 0.5, order: 0 })
    const c = cand("c", { proofStrength: 0.5, order: 1 })
    expect(selectLexicographic([a, b, c])).toBe("b")
  })

  it("tie-break is STABLE across repeated calls (call twice, same result)", () => {
    const list = [
      cand("a", { proofStrength: 0.5, order: 3 }),
      cand("b", { proofStrength: 0.5, order: 1 }),
      cand("c", { proofStrength: 0.5, order: 2 }),
    ]
    const first = selectLexicographic(list)
    const second = selectLexicographic(list)
    expect(first).toBe("b")
    expect(second).toBe(first)
  })

  it("only ADMISSIBLE candidates are eligible — an inadmissible stronger candidate is skipped", () => {
    const strongInadmissible = cand("strong", { proofStrength: 0.99 }, false)
    const weakAdmissible = cand("weak", { proofStrength: 0.01, ...tinyOver }, true)
    expect(selectLexicographic([strongInadmissible, weakAdmissible])).toBe("weak")
  })

  it("no admissible candidate → null", () => {
    expect(selectLexicographic([])).toBeNull()
    expect(
      selectLexicographic([
        cand("x", { proofStrength: 0.9 }, false),
        cand("y", { proofStrength: 0.8 }, false),
      ]),
    ).toBeNull()
  })

  it("first-seen admissible candidate is kept when it strictly ties a later one (stability)", () => {
    // identical tiers incl. order: comparator returns 0, so the earlier scan position is retained.
    const a = cand("a", { proofStrength: 0.5, order: 0 })
    const b = cand("b", { proofStrength: 0.5, order: 0 })
    expect(selectLexicographic([a, b])).toBe("a")
    expect(selectLexicographic([b, a])).toBe("b")
  })
})
