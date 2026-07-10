import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import {
  BODY_ATOMS,
  type InstructionAtom,
  NOTICE_ATOMS,
  POSTURE_ATOMS,
  type PromptContext,
  reachableBodyContexts,
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
    hasLanguageHint: false,
    hasEnvBlock: false,
    hasRepoRulesDynamic: false,
    hasTaskBudget: false,
    hasDirectives: false,
  })

  test("renderPostureBase == graph render for every posture", () => {
    for (const p of ["frozen", "owned", "default"] as const) {
      expect(renderPostureBase(p)).toEqual(renderAtoms(POSTURE_ATOMS, posture(p)))
    }
  })

  test("renderVerifyStrategy == graph render for every strategy (and undefined ⇒ [])", () => {
    expect(renderVerifyStrategy(undefined)).toEqual([])
    for (const s of ["reproduce-first", "verify-after-edit", "grader-only"] as const) {
      expect(renderVerifyStrategy(s)).toEqual(
        renderAtoms(VERIFY_ATOMS, { ...posture("frozen"), verifyStrategy: s }),
      )
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

  test("Phase 2 — BODY / NOTICE atoms carry doc-comment provenance metadata (§4 citations moved OUT of the source comments)", () => {
    // §KEY-TRANSFORM 4 moves the SOURCE DOC-COMMENT citations into `provenance`.
    // It does NOT strip citations that are part of the RENDERED wire text — the
    // body prose legitimately names ADRs inline (e.g. "User intent discipline
    // (ADR-0067; Codex L213-214)"), and byte-equivalence FORBIDS removing them.
    // So the invariant here is: the atoms that had doc-comment citations expose
    // them via `provenance` (metadata, never re-derived from the rendered lines).
    const withProv = [...BODY_ATOMS, ...NOTICE_ATOMS].filter((a) => (a.provenance?.length ?? 0) > 0)
    expect(withProv.length).toBeGreaterThan(0)
    const anyCitation = withProv.some((a) =>
      (a.provenance ?? []).some(
        (p) => p.includes("ADR-") || p.includes("RFC") || p.includes("Codex") || p.includes("jul-"),
      ),
    )
    expect(anyCitation).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ADR-0538 Phase 2 — the BODY + NOTICE slice over the widened reachable ctx
// surface (envPosture × verifyStrategy × mode × brief). Adds coverage for the
// four Phase-2 verifier checks (cached-section budget / static-dynamic
// separation / authority placement / manifest completeness) with red-on-injection.
// ─────────────────────────────────────────────────────────────────────────
const BODY_REACHABLE = reachableBodyContexts()
const BODY_AND_NOTICE = [...BODY_ATOMS, ...NOTICE_ATOMS]

describe("prompt-graph Phase 2 — BODY + NOTICE slice is sound", () => {
  test("reachable body ctx surface is envPosture×verify×mode×brief (3×4×6×2=144)", () => {
    expect(BODY_REACHABLE.length).toBe(144)
  })

  test("ZERO violations over the full reachable body ctx set", () => {
    const violations = verifyRuleGraph(BODY_AND_NOTICE, BODY_REACHABLE)
    expect(violations.map((v) => v.message)).toEqual([])
    expect(violations.length).toBe(0)
  })

  test("every BODY / NOTICE variant fires in ≥1 reachable ctx (no dead rule)", () => {
    const cov = verifyRuleGraph(BODY_AND_NOTICE, BODY_REACHABLE).filter(
      (v) => v.kind === "coverage",
    )
    expect(cov).toEqual([])
  })

  test("the two completion-bar variants NEVER co-render (conflict-freedom holds)", () => {
    const conflicts = verifyRuleGraph(BODY_AND_NOTICE, BODY_REACHABLE).filter(
      (v) => v.kind === "conflict",
    )
    expect(conflicts).toEqual([])
  })
})

describe("prompt-graph Phase 2 — RED on the four new checks", () => {
  test("(6) authority-placement: an L6_repo atom on system.base ⇒ violation", () => {
    const leaky: InstructionAtom = {
      atomId: "X-REPO",
      variantId: "X-REPO#leak",
      authority: "L6_repo",
      channel: "system.base",
      section: "body.after_persona",
      order: 999,
      lines: ["- repo-local rule leaking into the frozen system base"],
    }
    const v = verifyRuleGraph([...BODY_AND_NOTICE, leaky], BODY_REACHABLE)
    const placement = v.filter((x) => x.kind === "authority-placement")
    expect(placement.length).toBeGreaterThan(0)
    expect(placement.some((x) => x.variantIds.includes("X-REPO#leak"))).toBe(true)
  })

  test("(5) static-dynamic-separation: a per-turn-facet atom on a cached channel ⇒ violation", () => {
    const leaky: InstructionAtom = {
      atomId: "X-DYN",
      variantId: "X-DYN#leak",
      authority: "L1_system",
      channel: "system.base",
      section: "body.after_persona",
      order: 998,
      // conditions on a PER-TURN presence facet — must not ride a cached section.
      when: { hasMemorySummary: true },
      lines: ["- per-turn memory-conditioned rule wrongly in the cached prefix"],
    }
    const v = verifyRuleGraph([...BODY_AND_NOTICE, leaky], BODY_REACHABLE)
    const sep = v.filter((x) => x.kind === "static-dynamic-separation")
    expect(sep.length).toBeGreaterThan(0)
    expect(sep.some((x) => x.variantIds.includes("X-DYN#leak"))).toBe(true)
  })

  test("(8) manifest-completeness: a duplicate variantId ⇒ violation", () => {
    const dup: InstructionAtom = {
      atomId: "BODY-POLICY-STACK",
      variantId: "BODY-POLICY-STACK", // collides with the real policy-stack atom
      authority: "L1_system",
      channel: "system.base",
      section: "body.after_persona",
      order: 997,
      lines: ["- duplicate id"],
    }
    const v = verifyRuleGraph([...BODY_AND_NOTICE, dup], BODY_REACHABLE)
    const man = v.filter((x) => x.kind === "manifest-completeness")
    expect(man.length).toBeGreaterThan(0)
  })

  test("(4) cached-section-budget: within budget passes; a 5th live system.* section ⇒ violation", () => {
    // The budget (≤4 Anthropic cache breakpoints) is a property of the RENDERED
    // sections, not the atom graph (every atom rides system.base). The check
    // therefore runs on the MANIFEST — where the caller-data cache sections
    // (project_md/session_ctx/user_append) become visible — as defense-in-depth
    // against a future 5th cached section / mislabel. A per-CTX atom count could
    // only ever see {system.base} (≤1) and would be a tautology (the old check).
    const clean = {
      byChannel: {
        "system.base": [],
        "system.project_md": ["SECTION-project_md"],
        "system.session_ctx": ["SECTION-session_ctx"],
        "system.user_append": ["SECTION-user_append"],
        "message.hook_context": [],
        "message.context_update": [],
        "message.mention_injection": [],
        "message.system_reminder": [],
      } as Record<string, readonly string[]>,
      policy: { firedAtomIds: [] as string[] },
    }
    // 3 live system.* sections → within budget → no violation.
    const ok = verifyRuleGraph(BODY_AND_NOTICE, [], {
      ...clean,
      firedVariantIds: ["SECTION-project_md", "SECTION-session_ctx", "SECTION-user_append"],
    } as unknown as Parameters<typeof verifyRuleGraph>[2]).filter(
      (x) => x.kind === "cached-section-budget",
    )
    expect(ok).toEqual([])
    // Forge a FIFTH live system.* section → over budget → RED.
    const poisoned = verifyRuleGraph(BODY_AND_NOTICE, [], {
      firedVariantIds: [
        "SECTION-project_md",
        "SECTION-session_ctx",
        "SECTION-user_append",
        "SECTION-a",
        "SECTION-b",
      ],
      byChannel: {
        ...clean.byChannel,
        "system.phantom_a": ["SECTION-a"],
        "system.phantom_b": ["SECTION-b"],
      },
      policy: { firedAtomIds: [] as string[] },
    } as unknown as Parameters<typeof verifyRuleGraph>[2]).filter(
      (x) => x.kind === "cached-section-budget",
    )
    expect(poisoned.length).toBeGreaterThan(0)
  })

  test("(2b) edge integrity: a conflictsWith target that does not exist ⇒ violation", () => {
    // A dangling supersede/conflict/requires edge silently does nothing (a typo or
    // rename) — the integrity check makes it fail loudly. This is the red-on-
    // injection proof that the supersede-family check is NOT a tautology.
    const dangling: InstructionAtom = {
      atomId: "X-DANGLE",
      variantId: "X-DANGLE#leak",
      authority: "L1_system",
      channel: "system.base",
      section: "body.after_persona",
      order: 996,
      conflictsWith: ["NO-SUCH-VARIANT"],
      lines: ["- an atom whose conflictsWith target does not exist"],
    }
    const v = verifyRuleGraph([...BODY_AND_NOTICE, dangling], BODY_REACHABLE)
    const integ = v.filter((x) => x.kind === "supersede-unsound")
    expect(integ.length).toBeGreaterThan(0)
    expect(integ.some((x) => x.variantIds.includes("NO-SUCH-VARIANT"))).toBe(true)
  })
})
