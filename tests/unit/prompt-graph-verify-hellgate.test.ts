import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import {
  type InstructionAtom,
  POSTURE_ATOMS,
  type PromptContext,
  reachableToolUseContexts,
  renderAtoms,
  TOOL_USE_ATOMS,
  VERIFY_ATOMS,
  verifyRuleGraph,
} from "@/agent/prompt-graph"
import { renderPostureBase, renderVerifyStrategy } from "@/agent/prompt-rules"

/**
 * ADR-0538 Phase 1 hellgate — the build-time graph verifier over the MIGRATED
 * tool-use-rule slice (posture base ∪ verify strategy).
 *
 * Asserts:
 *   1. verifyRuleGraph over the FULL reachable posture×verify ctx set = ZERO
 *      violations (the graph is sound as shipped).
 *   2. RED-ON-INJECTION: a conflictsWith edge between two CO-RENDERING atoms, or
 *      a hidden-assumption atom without its facet, makes the verifier RED.
 *   3. BYTE-EQUIVALENCE: the graph-derived render == the render-path output for
 *      every posture / verify strategy (buildSystemPrompt is unchanged).
 *   4. NO-PROVENANCE-LEAK: no migrated atom's rendered lines contain an "ADR-"
 *      or "Codex " substring (citations live in `provenance`, never rendered).
 */

const REACHABLE = reachableToolUseContexts()

describe("prompt-graph verifyRuleGraph — migrated tool-use slice is sound", () => {
  test("reachable ctx surface is the full posture×verify cross (3×4=12)", () => {
    expect(REACHABLE.length).toBe(12)
  })

  test("ZERO violations over the full reachable ctx set", () => {
    const violations = verifyRuleGraph(TOOL_USE_ATOMS, REACHABLE)
    // structured, empty ⇒ sound. Surface the messages if it ever regresses.
    expect(violations.map((v) => v.message)).toEqual([])
    expect(violations.length).toBe(0)
  })

  test("every migrated variant fires in ≥1 reachable ctx (no dead rule)", () => {
    const cov = verifyRuleGraph(TOOL_USE_ATOMS, REACHABLE).filter((v) => v.kind === "coverage")
    expect(cov).toEqual([])
  })
})

describe("prompt-graph verifyRuleGraph — RED on injection", () => {
  test("a conflictsWith edge between two CO-RENDERING atoms ⇒ conflict violation", () => {
    // R-SEARCH-FIRST and R-READ-FAILURE both fire in EVERY posture (unconditional
    // honesty rails) → they co-render. Injecting a conflictsWith edge must trip
    // the conflict-freedom check.
    const poisoned: InstructionAtom[] = TOOL_USE_ATOMS.map((a) =>
      a.variantId === "R-SEARCH-FIRST"
        ? { ...a, conflictsWith: [...(a.conflictsWith ?? []), "R-READ-FAILURE"] }
        : a,
    )
    const violations = verifyRuleGraph(poisoned, REACHABLE)
    const conflicts = violations.filter((v) => v.kind === "conflict")
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0]?.variantIds).toContain("R-SEARCH-FIRST")
    expect(conflicts[0]?.variantIds).toContain("R-READ-FAILURE")
  })

  test("a hidden-assumption atom WITHOUT its facet ⇒ hidden-assumption violation", () => {
    // An atom asserting a "do not install" env premise but declaring NO
    // envPosture facet — the exact jul-10 contradiction class the lint catches.
    const leaky: InstructionAtom = {
      atomId: "R-LEAK",
      variantId: "R-LEAK#leak",
      authority: "L1_system",
      channel: "system.base",
      section: "tooluse.posture",
      order: 999,
      // NO `when` ⇒ no envPosture facet ⇒ unconditioned install-prohibition.
      lines: ["- [R-LEAK] Do NOT install anything, ever, in any environment."],
    }
    const violations = verifyRuleGraph([...TOOL_USE_ATOMS, leaky], REACHABLE)
    const hidden = violations.filter((v) => v.kind === "hidden-assumption")
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.some((v) => v.variantIds.includes("R-LEAK#leak"))).toBe(true)
  })

  test("the SAME leaky premise WITH its envPosture facet ⇒ no violation (lint is precise)", () => {
    const conditioned: InstructionAtom = {
      atomId: "R-LEAK",
      variantId: "R-LEAK#frozen",
      authority: "L1_system",
      channel: "system.base",
      section: "tooluse.posture",
      order: 999,
      when: { envPosture: ["frozen"] }, // declares the premise's axis ⇒ sound.
      lines: ["- [R-LEAK] Do NOT install anything (frozen-only premise)."],
    }
    const violations = verifyRuleGraph([...TOOL_USE_ATOMS, conditioned], REACHABLE)
    expect(violations.filter((v) => v.kind === "hidden-assumption")).toEqual([])
  })
})

describe("prompt-graph — byte-equivalence with the render path", () => {
  const posture = (p: PromptContext["envPosture"]): PromptContext => ({
    envPosture: p,
    promptPack: "interactive",
    verifyStrategy: undefined,
    mode: "default",
    hasRepoRules: false,
    hasGlobRules: false,
    hasSessionCtx: false,
    hasMemorySummary: false,
    hasWorkingState: false,
    hasActiveSkills: false,
    hasContextEvents: false,
    hasMentionInjection: false,
    hasHookInjects: false,
    hasImages: false,
    brief: false,
    untrustedEnvelope: false,
  })

  test("renderPostureBase == graph render for every posture", () => {
    for (const p of ["frozen", "owned", "default"] as const) {
      expect(renderPostureBase(p)).toEqual(renderAtoms(POSTURE_ATOMS, posture(p)))
    }
  })

  test("renderVerifyStrategy == graph render for every strategy (and undefined ⇒ [])", () => {
    expect(renderVerifyStrategy(undefined)).toEqual([])
    for (const s of ["reproduce-first", "verify-after-edit", "grader-only"] as const) {
      expect(renderVerifyStrategy(s)).toEqual(renderAtoms(VERIFY_ATOMS, { ...posture("frozen"), verifyStrategy: s }))
    }
  })

  test("buildSystemPrompt still carries the exact posture rule tags per posture", () => {
    const frozen = buildSystemPrompt("/w", { envPosture: "frozen" })
    const owned = buildSystemPrompt("/w", { envPosture: "owned" })
    const dflt = buildSystemPrompt("/w", { envPosture: "default" })
    expect(frozen).toContain("[R-ENV]")
    expect(frozen).toContain("[R-STOP-ENV]")
    expect(owned).toContain("[R-ENV-OWNED]")
    expect(owned).not.toContain("[R-ENV]")
    expect(dflt).toContain("[R-ENV-LOCAL]")
    expect(dflt).not.toContain("[R-ENV]")
  })
})

describe("prompt-graph — provenance never leaks into rendered output", () => {
  test("no migrated atom's rendered lines contain an ADR-/Codex citation", () => {
    for (const a of TOOL_USE_ATOMS) {
      const text = a.lines.join("\n")
      expect(text).not.toContain("ADR-")
      expect(text).not.toContain("Codex ")
    }
  })

  test("some migrated atoms DO carry provenance metadata (proving it was moved OUT, not dropped)", () => {
    const withProv = TOOL_USE_ATOMS.filter((a) => (a.provenance?.length ?? 0) > 0)
    expect(withProv.length).toBeGreaterThan(0)
    // and the provenance is where the citations live.
    const anyCitation = withProv.some((a) =>
      (a.provenance ?? []).some((p) => p.includes("ADR-") || p.includes("RFC") || p.includes("P6")),
    )
    expect(anyCitation).toBe(true)
  })
})
