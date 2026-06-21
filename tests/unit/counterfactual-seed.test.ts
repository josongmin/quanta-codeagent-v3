import { describe, expect, it } from "bun:test"
import type { CandidateRiskFacts } from "@/runner/batch/eval/counterfactual-risk"
import { buildCounterfactualSeed } from "@/runner/batch/eval/counterfactual-seed"

const baseFacts = (overrides: Partial<CandidateRiskFacts> = {}): CandidateRiskFacts => ({
  touchedSourceFiles: 1,
  ownerFiles: ["pkg/axis.py"],
  filesOutsideOwner: [],
  newFiles: 0,
  newDefs: 0,
  runtimeExpandingCalls: 0,
  crossFile: false,
  emptyPatch: false,
  applyClean: null,
  declaredExpectedMatch: null,
  structuralReasons: [],
  ...overrides,
})

describe("buildCounterfactualSeed", () => {
  it("multi-file/cross-file → owner-only constraint + pluralized 'touched 2 source files'", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({
        touchedSourceFiles: 2,
        crossFile: true,
        filesOutsideOwner: ["pkg/other.py"],
      }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("- edit only `pkg/axis.py`")
    expect(seed).toContain("- touched 2 source files")
    // mutation guard: unrelated facts did not fire ⇒ no def/runtime/empty bullets.
    expect(seed).not.toContain("no new helper")
    expect(seed).not.toContain("runtime-expanding")
    expect(seed).not.toContain("non-empty and apply cleanly")
  })

  it("new-def → 'no new helper/class/method' and singular 'added 1 new def'", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ newDefs: 1 }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("- no new helper/class/method")
    expect(seed).toContain("- added 1 new def")
    // singular, not plural.
    expect(seed).not.toContain("added 1 new defs")
  })

  it("new-def plural wording for newDefs=2", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ newDefs: 2 }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toContain("- added 2 new defs/class")
  })

  it("runtime-expanding → avoid-calls AND preserve control flow bullets", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ runtimeExpandingCalls: 2 }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("- avoid runtime-expanding calls")
    expect(seed).toContain("- preserve existing control flow")
    expect(seed).toContain("- added 2 runtime-expanding calls")
  })

  it("empty patch → 'non-empty and apply cleanly' constraint + reason bullet", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ emptyPatch: true }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("- produced an empty patch")
    expect(seed).toContain("- the patch must be non-empty and apply cleanly")
  })

  it("within-budget facts (all zero/false) → undefined (self-guard / red-on-injection)", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts(),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeUndefined()
  })

  it("no owner file at all → generic phrasing, no backtick path, still a seed when a reason fired", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({
        touchedSourceFiles: 2,
        crossFile: true,
        ownerFiles: [],
      }),
      ownerFile: undefined,
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("- edit the smallest set of source files")
    expect(seed).not.toContain("`")
  })

  it("falls back to facts.ownerFiles[0] when ownerFile is undefined", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({
        touchedSourceFiles: 2,
        crossFile: true,
        ownerFiles: ["pkg/fallback.py"],
      }),
      ownerFile: undefined,
    })
    expect(seed).toContain("- edit only `pkg/fallback.py`")
  })

  it("a non-firing fact emits NO bullet (mutation-killing negative assertion)", () => {
    // Only emptyPatch fired; newDefs=0 so the 'no new helper' bullet must be absent.
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ emptyPatch: true }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).not.toContain("no new helper")
    expect(seed).not.toContain("added 0 new")
    expect(seed).not.toContain("touched 1 source file")
  })
})
