import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"
import {
  ALL_ATOMS,
  BODY_ATOMS,
  DYNAMIC_PRESENCE_FACETS,
  type InstructionAtom,
  NOTICE_ATOMS,
  POSTURE_ATOMS,
  PROMPT_CTX_DEFAULTS,
  type PromptContext,
  reachableAllContexts,
  reachableBodyContexts,
  reachableToolUseContexts,
  renderAtoms,
  selectAtoms,
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
    ...PROMPT_CTX_DEFAULTS,
    envPosture: p,
    verifyStrategy: undefined,
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
  test("reachable body ctx surface is envPosture×verify×mode×brief×delegSuppress (3×4×6×2×2=288)", () => {
    expect(BODY_REACHABLE.length).toBe(288)
  })

  test("delegation-suppress cross is BALANCED 144/144 (not a skewed 287/1 that still totals 288)", () => {
    // C5059-05: a mis-wired cross could keep the 288 count while barely exercising
    // one facet value. Both A_TOOL_ROUTING variants need a full 144-ctx surface.
    const f = BODY_REACHABLE.filter((c) => c.hasDelegationSuppress === false).length
    const t = BODY_REACHABLE.filter((c) => c.hasDelegationSuppress === true).length
    expect({ f, t }).toEqual({ f: 144, t: 144 })
  })

  // SOTA++ generalization: several atomIds document "exactly one variant renders
  // (disjoint `when`)" but only BODY-TOOL-ROUTING had a test — R-ENV / R-NO-SHIM
  // relied on comments alone. Promote the partition invariant to a shared guard.
  // These 3 are the PROVEN partitions (probed: exactly-one in every reachable
  // ctx); the other multi-variant atomIds (BODY-OPERATING-PRINCIPLES / -BUDGET /
  // -TOOL-FAILURES / -VISION / -COMPLETION-BAR) are additive-or-conditional and
  // are DELIBERATELY excluded (blanket exactly-one would false-positive them).
  const PARTITION_ATOM_IDS = ["R-ENV", "R-NO-SHIM", "BODY-TOOL-ROUTING"] as const

  test("every documented PARTITION atomId fires EXACTLY ONCE in every reachable ctx", () => {
    const allCtx = reachableAllContexts()
    for (const atomId of PARTITION_ATOM_IDS) {
      // sanity: the atomId actually has >1 variant (else the guard is vacuous)
      expect(ALL_ATOMS.filter((a) => a.atomId === atomId).length, atomId).toBeGreaterThan(1)
      for (const ctx of allCtx) {
        const n = selectAtoms(ALL_ATOMS, ctx).filter((a) => a.atomId === atomId).length
        expect(
          n,
          `${atomId} @ ${JSON.stringify({ posture: ctx.envPosture, mode: ctx.mode })}`,
        ).toBe(1)
      }
    }
  })

  test("the additive multi-variant atomIds are NOT partitions (classification pin)", () => {
    // Pins WHY the excluded ones are excluded — if one silently became a partition
    // (or a partition became additive), this flags the reclassification.
    const allCtx = reachableAllContexts()
    const renderCounts = (atomId: string) =>
      new Set(
        allCtx.map((ctx) => selectAtoms(ALL_ATOMS, ctx).filter((a) => a.atomId === atomId).length),
      )
    // additive: at least one ctx renders ≥2 variants together
    expect([...renderCounts("BODY-OPERATING-PRINCIPLES")].some((n) => n >= 2)).toBe(true)
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

  test("(3) coverage: an atom gated on an UNREACHABLE facet ⇒ coverage violation", () => {
    // The body ctx surface holds every presence facet FALSE, so an atom gated on a
    // per-turn presence facet never fires there → it is a dead/inert rule. Proves
    // the coverage check is red-on-injection (not just green on the real set).
    const dead: InstructionAtom = {
      atomId: "X-DEAD",
      variantId: "X-DEAD#inert",
      authority: "L1_system",
      channel: "message.system_reminder",
      section: "dynamic.reminder",
      order: 995,
      when: { hasMemorySummary: true }, // never true in reachableBodyContexts
      lines: [],
      contentKey: "x-dead",
    }
    const cov = verifyRuleGraph([...BODY_AND_NOTICE, dead], BODY_REACHABLE).filter(
      (x) => x.kind === "coverage",
    )
    expect(cov.some((x) => x.variantIds.includes("X-DEAD#inert"))).toBe(true)
  })

  test("(8) manifest-completeness: an EMPTY variantId ⇒ violation", () => {
    // Every rendered span must trace to a non-empty variantId; a blank id would make
    // the fired-atom manifest ambiguous. Red-on-injection for the empty-id branch.
    const blank: InstructionAtom = {
      atomId: "X-BLANK",
      variantId: "",
      authority: "L1_system",
      channel: "system.base",
      section: "body.after_persona",
      order: 994,
      lines: ["- an atom with a blank variantId"],
    }
    const man = verifyRuleGraph([...BODY_AND_NOTICE, blank], BODY_REACHABLE).filter(
      (x) => x.kind === "manifest-completeness",
    )
    expect(man.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Coverage-ENUMERATION soundness — the load-bearing assumption behind
// reachableAllContexts() (contexts.ts DYNAMIC_PRESENCE_FACETS). The whole-graph
// coverage / conflict / supersede sweeps run over reachableAllContexts(), which
// toggles each dynamic presence facet ON one-at-a-time (NO 2^N cross). That is a
// SOUND stand-in for the true reachable surface ONLY while no atom conditions on
// ≥2 dynamic facets at once: a 2-facet `when` fires in production (both facets
// true) but in NO single-facet enumerated ctx, so a conflict that only manifests
// when both are true would be silently missed. This ratchet turns that implicit
// assumption into an explicit, named, RED-on-injection invariant.
// ─────────────────────────────────────────────────────────────────────────
describe("prompt-graph — single-presence-facet coverage invariant (contexts.ts SSOT)", () => {
  const presenceFacetsOf = (a: InstructionAtom): string[] =>
    DYNAMIC_PRESENCE_FACETS.filter(
      (f) => (a.when as Record<string, unknown> | undefined)?.[f as string] !== undefined,
    ).map(String)

  test("no shipped atom conditions on ≥2 dynamic presence facets at once", () => {
    const offenders = ALL_ATOMS.map((a) => ({
      variantId: a.variantId,
      facets: presenceFacetsOf(a),
    })).filter((x) => x.facets.length >= 2)
    // A ≥2-facet `when` never fires in reachableAllContexts()'s one-at-a-time
    // enumeration → the coverage/conflict sweeps silently under-exercise it.
    expect(offenders).toEqual([])
  })

  test("ANTI-VACUOUS: some shipped atom DOES condition on exactly one dynamic facet", () => {
    // Without this, the guard above passes vacuously if NO atom ever reads a
    // dynamic facet — the enumeration would be exercising nothing.
    const single = ALL_ATOMS.filter((a) => presenceFacetsOf(a).length === 1)
    expect(single.length).toBeGreaterThan(0)
  })

  test("RED-ON-INJECTION: a 2-facet atom trips the guard AND a real coverage violation", () => {
    const twoFacet: InstructionAtom = {
      atomId: "X-2FACET",
      variantId: "X-2FACET#inert",
      authority: "L1_system",
      channel: "message.system_reminder",
      section: "dynamic.reminder",
      order: 993,
      // BOTH facets required — never simultaneously ON in reachableAllContexts().
      when: { hasImages: true, hasLanguageHint: true },
      lines: [],
      contentKey: "x-2facet",
    }
    // (a) the guard predicate flags it
    expect(presenceFacetsOf(twoFacet).length).toBe(2)
    // (b) and the verifier reports it as an (unreachable) dead rule over the full set
    const cov = verifyRuleGraph([...ALL_ATOMS, twoFacet], reachableAllContexts()).filter(
      (v) => v.kind === "coverage" && v.variantIds.includes("X-2FACET#inert"),
    )
    expect(cov.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// No-hidden-assumption lint — ANTI-VACUITY via RED-ON-INJECTION. verify.ts's
// ASSUMPTION_TABLE is a deliberate SUPERSET (its docstring commissions some
// keywords as forward tripwires for premise phrasings not yet written). The lint
// is only meaningful while its keywords still match REAL shipped premise text —
// a reword that drifted every premise atom away from the table would leave the
// lint GREEN while guarding nothing.
//
// We prove liveness WITHOUT duplicating the keyword list (which would itself go
// stale and pass while the lint's own table died — the exact failure mode this
// guards): take a REAL shipped premise atom (R-ENV#frozen carries the
// install-prohibition premise, scoped by `when.envPosture`), strip its scope, and
// assert the lint fires. If the atom's text ever drifts off every table keyword,
// the stripped atom stops tripping the lint → this goes RED. A paired control on
// the unmodified atom proves the violation is caused by the missing facet, not
// the text alone.
// ─────────────────────────────────────────────────────────────────────────
describe("prompt-graph — no-hidden-assumption lint fires on a real shipped premise (not inert)", () => {
  const R_ENV_FROZEN_ID = "R-ENV#frozen"

  test("stripping R-ENV#frozen's envPosture scope ⇒ a hidden-assumption violation", () => {
    const rEnv = ALL_ATOMS.find((a) => a.variantId === R_ENV_FROZEN_ID)
    expect(
      rEnv,
      `${R_ENV_FROZEN_ID} must exist (the shipped install-prohibition premise)`,
    ).toBeDefined()
    // Drop `when` ⇒ the install-prohibition premise now renders unconditioned.
    const { when: _dropped, ...unconditioned } = rEnv as InstructionAtom
    const others = ALL_ATOMS.filter((a) => a.variantId !== R_ENV_FROZEN_ID)
    const hidden = verifyRuleGraph(
      [...others, unconditioned as InstructionAtom],
      reachableAllContexts(),
    ).filter((v) => v.kind === "hidden-assumption" && v.variantIds.includes(R_ENV_FROZEN_ID))
    expect(hidden.length).toBeGreaterThan(0)
  })

  test("CONTROL: the unmodified R-ENV#frozen ⇒ no hidden-assumption violation", () => {
    // Same atom, scope intact — proves the violation above comes from the stripped
    // facet, not merely from the premise text (a text-only assertion would be a
    // tautology; this pins it to the facet).
    const hidden = verifyRuleGraph(ALL_ATOMS, reachableAllContexts()).filter(
      (v) => v.kind === "hidden-assumption" && v.variantIds.includes(R_ENV_FROZEN_ID),
    )
    expect(hidden).toEqual([])
  })
})
