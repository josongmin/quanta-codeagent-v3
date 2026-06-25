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
    // Evidential owner-file framing (no imperative "edit only").
    expect(seed).toContain("the owner file appears to be `pkg/axis.py`")
    expect(seed).toContain("prefer it")
    expect(seed).not.toContain("edit only")
    // The structural facts are still surfaced.
    expect(seed).toContain("- touched 2 source files")
    // The model is asked to judge, not commanded.
    expect(seed).toContain("Consider whether a smaller in-place alternative")
    expect(seed).toContain("if the broader change is genuinely required")
    // mutation guard: unrelated facts did not fire ⇒ no def/runtime/empty bullets.
    expect(seed).not.toContain("new helpers/classes/methods")
    expect(seed).not.toContain("runtime-expanding")
    expect(seed).not.toContain("non-empty and apply cleanly")
  })

  it("new-def → 'no new helper/class/method' and singular 'added 1 new def'", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ newDefs: 1 }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("new helpers/classes/methods may not be necessary")
    expect(seed).toContain("- added 1 new def")
    // singular, not plural.
    expect(seed).not.toContain("added 1 new defs")
    // No imperative command.
    expect(seed).not.toContain("- no new helper/class/method")
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
    expect(seed).toContain("runtime-expanding calls (compiler/IO/DB/subprocess) may not be necessary")
    expect(seed).toContain("changing the existing control flow may not be necessary")
    expect(seed).toContain("- added 2 runtime-expanding calls")
    // No imperative command.
    expect(seed).not.toContain("- avoid runtime-expanding calls")
    expect(seed).not.toContain("- preserve existing control flow")
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
    expect(seed).toContain("if a smaller edit to fewer source files fully fixes the issue, prefer it")
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
    expect(seed).toContain("the owner file appears to be `pkg/fallback.py`")
  })

  it("a non-firing fact emits NO bullet (mutation-killing negative assertion)", () => {
    // Only emptyPatch fired; newDefs=0 so the 'no new helper' bullet must be absent.
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ emptyPatch: true }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    expect(seed).not.toContain("new helpers/classes/methods")
    expect(seed).not.toContain("added 0 new")
    expect(seed).not.toContain("touched 1 source file")
  })

  it("EVIDENTIAL: structural seed surfaces facts + a judgement question, no imperative directives", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts({
        touchedSourceFiles: 2,
        crossFile: true,
        newDefs: 1,
        runtimeExpandingCalls: 1,
        filesOutsideOwner: ["pkg/other.py"],
      }),
      ownerFile: "pkg/axis.py",
    })
    expect(seed).toBeDefined()
    // Frames as facts + a question the model decides.
    expect(seed).toContain("Facts about its patch")
    expect(seed).toContain("Consider whether a smaller in-place alternative fully fixes the issue")
    expect(seed).toContain(
      "if the broader change is genuinely required to fix the issue, keep it and explain why",
    )
    // None of the old imperative conclusion-assertions survive.
    expect(seed).not.toContain("Produce a counterfactual minimal alternative")
    expect(seed).not.toContain("edit only")
    expect(seed).not.toContain("- no new helper")
    expect(seed).not.toContain("- avoid runtime-expanding")
    expect(seed).not.toContain("- preserve existing control flow")
  })
})
