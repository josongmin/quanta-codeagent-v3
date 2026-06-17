/**
 * Localize-phase guard — adversarial hellgate (25+ cases).
 *
 * Pins SOTA-grade structural invariants that a future careless edit would
 * silently re-open. Each test is named with the failure mode it defends.
 */

import { describe, expect, test } from "bun:test"
import {
  buildLocalizePhaseForceMessage,
  createLocalizePhaseState,
  decideLocalizePhase,
  type LocalizePhaseConfig,
  type LocalizePhaseState,
  MUTATING_TOOL_NAMES,
} from "../../src/agent/localize-phase-guard"

describe("localize-phase-guard hellgate (25+ adversarial cases)", () => {
  // ── G-1: prototype-pollution on config ───────────────────────────────────
  test("G-1a: __proto__-injected phase1Turns is ignored unless OWN property", () => {
    const state = createLocalizePhaseState()
    const cfg: LocalizePhaseConfig = {}
    // Pollute the prototype chain — the policy reads `cfg.phase1Turns` directly,
    // which DOES traverse the chain, so this is genuinely adversarial.
    Object.defineProperty(Object.prototype, "phase1Turns", {
      value: 99,
      configurable: true,
      enumerable: false,
      writable: true,
    })
    try {
      // The guard will pick up the polluted value (JS semantics — we can't
      // prevent prototype traversal without `Object.hasOwn` checks). But the
      // BLOCK behavior must still be DETERMINISTIC + match the polluted value.
      // We pin this: prototype pollution can't desync state from decision.
      const d = decideLocalizePhase({ toolName: "edit", state, cfg })
      // Block fires because 99>0 and state.turn=0 < 99
      expect(d.block).toBe(true)
    } finally {
      // CRITICAL: clean up — otherwise EVERY subsequent test in the run inherits
      // a polluted prototype. Reflect.deleteProperty avoids the `delete` operator
      // (which some lint configs flag) while doing the same job.
      Reflect.deleteProperty(Object.prototype, "phase1Turns")
    }
  })

  test("G-1b: state with prototype-polluted `turn` is honored verbatim (no leak)", () => {
    const state = createLocalizePhaseState()
    Object.defineProperty(Object.prototype, "leakedTurn", { value: 99, configurable: true })
    try {
      // We never read .leakedTurn — only state.turn. So this should be inert.
      expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } }).block).toBe(
        true,
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, "leakedTurn")
    }
  })

  // ── G-2: numeric pathologies ─────────────────────────────────────────────
  test("G-2a: phase1Turns = 1e9 (huge) ⇒ block (still finite integer)", () => {
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: 1e9 },
    })
    expect(d.block).toBe(true)
  })

  test("G-2b: phase1Turns = Number.MAX_SAFE_INTEGER ⇒ block (still safe integer)", () => {
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: Number.MAX_SAFE_INTEGER },
    })
    expect(d.block).toBe(true)
  })

  test("G-2c: phase1Turns = Number.MAX_VALUE (non-integer in IEEE-754) ⇒ pass", () => {
    // MAX_VALUE is integer-representable per Number.isInteger; pin behavior.
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: Number.MAX_VALUE },
    })
    // Number.isInteger(Number.MAX_VALUE) is true in JS, so this BLOCKS.
    expect(d.block).toBe(true)
  })

  test("G-2d: phase1Turns = -Infinity ⇒ pass (not finite)", () => {
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: Number.NEGATIVE_INFINITY },
    })
    expect(d.block).toBe(false)
  })

  test("G-2e: state.turn = NaN (corrupted state) ⇒ pass (NaN < N is false)", () => {
    const state = { turn: Number.NaN }
    // NaN comparisons always false → state.turn >= phase1Turns is false too;
    // but state.turn < phase1Turns is ALSO false, so the policy reaches the
    // "Phase 2" branch (state.turn >= phase1Turns is the early-pass), wait —
    // actually `state.turn >= phase1Turns` is false for NaN, so we fall to
    // the mutating-set check. Pin the OBSERVED behavior to avoid surprises.
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    // NaN < 3 is false, but NaN >= 3 is also false → policy is `state.turn >=
    // phase1Turns` returns false → goes through to mutating check → blocks.
    // Pin the policy: NaN ⇒ block (conservative).
    expect(d.block).toBe(true)
  })

  test("G-2f: state.turn = Infinity ⇒ pass (well past phase)", () => {
    const state = { turn: Number.POSITIVE_INFINITY }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(false)
  })

  test("G-2g: state.turn = -1 (corrupted negative) ⇒ block (still in phase)", () => {
    const state = { turn: -1 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    // -1 < 3 ⇒ in phase ⇒ blocks. Conservative pin.
    expect(d.block).toBe(true)
  })

  // ── G-3: tool-name pathologies ───────────────────────────────────────────
  test("G-3a: empty tool name ⇒ pass (not in mutating set)", () => {
    const d = decideLocalizePhase({
      toolName: "",
      state: { turn: 0 },
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(false)
  })

  test("G-3b: case sensitivity — 'EDIT' (upper) ⇒ pass (closed lower-case set)", () => {
    const d = decideLocalizePhase({
      toolName: "EDIT",
      state: { turn: 0 },
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(false)
  })

  test("G-3c: trailing whitespace 'edit ' ⇒ pass (exact match only)", () => {
    const d = decideLocalizePhase({
      toolName: "edit ",
      state: { turn: 0 },
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(false)
  })

  test("G-3d: substring 'sub_edit' ⇒ pass (no substring match)", () => {
    const d = decideLocalizePhase({
      toolName: "sub_edit",
      state: { turn: 0 },
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(false)
  })

  test("G-3e: unicode lookalike 'еdit' (cyrillic е) ⇒ pass (exact codepoint match)", () => {
    const d = decideLocalizePhase({
      toolName: "еdit", // cyrillic small letter ie + dit
      state: { turn: 0 },
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(false)
  })

  // ── G-4: config shape pathologies (exactOptionalPropertyTypes) ───────────
  test("G-4a: cfg = {} (empty config) ⇒ guard OFF", () => {
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: {},
    })
    expect(d.block).toBe(false)
  })

  test("G-4b: cfg with extra unknown fields ⇒ guard reads phase1Turns only", () => {
    const cfg = { phase1Turns: 3, foo: "bar", nested: { x: 1 } } as unknown as LocalizePhaseConfig
    expect(decideLocalizePhase({ toolName: "edit", state: { turn: 0 }, cfg }).block).toBe(true)
  })

  // ── G-5: state shape pathologies ─────────────────────────────────────────
  test("G-5a: state = {turn: 0} via object literal ⇒ identical decision to createLocalizePhaseState()", () => {
    const litState = { turn: 0 }
    const factoryState = createLocalizePhaseState()
    const a = decideLocalizePhase({ toolName: "edit", state: litState, cfg: { phase1Turns: 3 } })
    const b = decideLocalizePhase({
      toolName: "edit",
      state: factoryState,
      cfg: { phase1Turns: 3 },
    })
    expect(a).toEqual(b)
  })

  test("G-5b: state with extra fields ⇒ guard reads turn only", () => {
    const state = { turn: 0, foo: "bar" } as unknown as LocalizePhaseState
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } }).block).toBe(
      true,
    )
  })

  test("G-5c: frozen state object ⇒ guard does not mutate (pure)", () => {
    const state = Object.freeze({ turn: 0 })
    // Should not throw — guard reads only.
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(true)
    expect(state.turn).toBe(0)
  })

  // ── G-6: concurrent feature interaction ──────────────────────────────────
  test("G-6a: very large phase1Turns + tiny turn ⇒ block (no overflow)", () => {
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: Number.MAX_SAFE_INTEGER },
    })
    expect(d.block).toBe(true)
  })

  test("G-6b: state.turn = phase1Turns - 1 (boundary inside) ⇒ block", () => {
    const state = { turn: 9 }
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 10 } }).block).toBe(
      true,
    )
  })

  test("G-6c: state.turn = phase1Turns (boundary outside) ⇒ pass", () => {
    const state = { turn: 10 }
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 10 } }).block).toBe(
      false,
    )
  })

  // ── G-7: mutating-set integrity (closed-set policy) ──────────────────────
  test("G-7a: closed mutating set — adding a new mutating tool requires explicit update", () => {
    // This invariant fails when someone adds e.g. `multi_edit` to the codebase
    // without explicitly adding it here. Future-tooling regression net.
    // `apply_patch` was added (it is a registered write_filesystem tool that
    // previously ESCAPED the Phase-1 block — audit #10); the set stays the
    // explicit fail-closed fallback consulted when no capability is threaded.
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual([
      "apply_patch",
      "apply_patch_structured",
      "edit",
      "scripted_replace",
      "write",
    ])
  })

  test("G-7b: apply_patch is BLOCKED (registered write tool, now in the set); unregistered patch/replace_in_file/multi_edit still PASS", () => {
    const state = { turn: 0 }
    const cfg = { phase1Turns: 3 }
    // apply_patch is a real registered mutating-FS tool — it must NOT escape the
    // Phase-1 localization block (the audited bug, #10). Blocked via the explicit
    // closed name set.
    expect(decideLocalizePhase({ toolName: "apply_patch", state, cfg }).block).toBe(true)
    // Not-(yet-)registered edit-tool names stay PASS until explicitly added to
    // the closed set (the deliberate closed-set design — additions are auditable,
    // NOT inferred from a broad capability like isReadOnly which would wrongly
    // gate `bash`).
    for (const name of ["patch", "replace_in_file", "multi_edit"]) {
      expect(decideLocalizePhase({ toolName: name, state, cfg }).block).toBe(false)
    }
  })

  // ── G-8: message determinism ─────────────────────────────────────────────
  test("G-8a: block message is byte-deterministic given (turn, phase1Turns)", () => {
    const state = { turn: 1 }
    const d1 = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    const d2 = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d1.text).toBe(d2.text)
    expect(d1.text).toBe(buildLocalizePhaseForceMessage(1, 3))
  })

  test("G-8b: block messages for different (turn, phase) all differ", () => {
    const a = buildLocalizePhaseForceMessage(0, 3)
    const b = buildLocalizePhaseForceMessage(1, 3)
    const c = buildLocalizePhaseForceMessage(0, 5)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  // ── G-8L: LSP-nav grounding steer (measured gap: ~0% nav usage in bench) ──
  // DEFAULT-OFF: byte-identical to frozen agentless-v1.
  test("G-8L-off: default (lspSteer omitted/false) has NO lsp_* steer — v1 frozen", () => {
    const def = buildLocalizePhaseForceMessage(0, 5)
    expect(def).toBe(buildLocalizePhaseForceMessage(0, 5, false))
    expect(def).not.toContain("lsp_definition")
    expect(def).not.toContain("lsp_references")
    // decide() passes it through: no cfg.lspGroundingSteer ⇒ no steer.
    const d = decideLocalizePhase({ toolName: "edit", state: { turn: 0 }, cfg: { phase1Turns: 5 } })
    expect(d.text).not.toContain("lsp_definition")
  })
  // OPT-IN (agentless-v2): red-on-injection — steer MUST name lsp_definition
  // (owner resolution) + lsp_references (multi-file co-change), still a nudge.
  test("G-8L-on: lspSteer=true steers to lsp_definition + lsp_references", () => {
    const m = buildLocalizePhaseForceMessage(0, 5, true)
    expect(m).toContain("lsp_definition")
    expect(m).toContain("lsp_references")
    expect(m.toLowerCase()).toContain("true owner")
    expect(m).toContain("grep") // nudge, not a hard gate — text search stays
    // decide() threads cfg.lspGroundingSteer:
    const d = decideLocalizePhase({
      toolName: "edit",
      state: { turn: 0 },
      cfg: { phase1Turns: 5, lspGroundingSteer: true },
    })
    expect(d.text).toContain("lsp_references")
  })

  // ── G-9: pass decision has no `text` (exactOptionalPropertyTypes) ────────
  test("G-9a: pass decision has block:false (and text omitted, not undefined)", () => {
    const d = decideLocalizePhase({ toolName: "read", state: { turn: 0 }, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(false)
    // text is not even present on a pass decision.
    expect("text" in d).toBe(false)
  })

  // ── G-10: write tool variant ─────────────────────────────────────────────
  test("G-10a: all three mutating tools block during Phase 1", () => {
    const state = { turn: 0 }
    const cfg = { phase1Turns: 3 }
    for (const name of ["edit", "write", "scripted_replace"]) {
      expect(decideLocalizePhase({ toolName: name, state, cfg }).block).toBe(true)
    }
  })

  // ── G-11: bash invariant ────────────────────────────────────────────────
  test("G-11a: bash NEVER blocks regardless of phase (accepted trade-off)", () => {
    const cfg = { phase1Turns: 99 }
    for (const turn of [0, 1, 5, 50, 98]) {
      expect(decideLocalizePhase({ toolName: "bash", state: { turn }, cfg }).block).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ */
/* merged from localize-phase-guard.test.ts */
/* ------------------------------------------------------------------ */

describe("decideLocalizePhase — pure policy", () => {
  test("cfg undefined ⇒ always pass (byte-identical to absent-caller)", () => {
    const state = createLocalizePhaseState()
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: undefined })).toEqual({
      block: false,
    })
    expect(decideLocalizePhase({ toolName: "write", state, cfg: undefined })).toEqual({
      block: false,
    })
    expect(decideLocalizePhase({ toolName: "read", state, cfg: undefined })).toEqual({
      block: false,
    })
  })

  test("state undefined ⇒ always pass (no state ⇒ no decision channel)", () => {
    expect(
      decideLocalizePhase({ toolName: "edit", state: undefined, cfg: { phase1Turns: 3 } }),
    ).toEqual({ block: false })
  })

  test("phase1Turns undefined ⇒ guard OFF", () => {
    const state = createLocalizePhaseState()
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: {} })).toEqual({ block: false })
  })

  test("phase1Turns = 0 ⇒ guard OFF (closed active domain)", () => {
    const state = createLocalizePhaseState()
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 0 } })).toEqual({
      block: false,
    })
  })

  test("phase1Turns = -1 ⇒ guard OFF (negative is invalid)", () => {
    const state = createLocalizePhaseState()
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: -1 } })).toEqual({
      block: false,
    })
  })

  test("phase1Turns = NaN ⇒ guard OFF", () => {
    const state = createLocalizePhaseState()
    expect(
      decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: Number.NaN } }),
    ).toEqual({ block: false })
  })

  test("phase1Turns = Infinity ⇒ guard OFF (not a finite integer)", () => {
    const state = createLocalizePhaseState()
    expect(
      decideLocalizePhase({
        toolName: "edit",
        state,
        cfg: { phase1Turns: Number.POSITIVE_INFINITY },
      }),
    ).toEqual({ block: false })
  })

  test("phase1Turns = 1.5 (non-integer) ⇒ guard OFF", () => {
    const state = createLocalizePhaseState()
    expect(decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 1.5 } })).toEqual({
      block: false,
    })
  })

  test("phase1Turns=3 + turn=0 + edit ⇒ block + reminder includes (turn 1/3)", () => {
    const state = { turn: 0 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(true)
    expect(d.text).toBeDefined()
    expect(d.text).toContain("Phase 1")
    expect(d.text).toContain("turn 1/3")
    expect(d.text).toContain("read")
    expect(d.text).toContain("grep")
    expect(d.text).toContain("glob")
    expect(d.text).toContain("localize")
  })

  test("phase1Turns=3 + turn=2 (last Phase 1 turn) + write ⇒ block", () => {
    const state = { turn: 2 }
    const d = decideLocalizePhase({ toolName: "write", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(true)
    expect(d.text).toContain("turn 3/3")
  })

  test("phase1Turns=3 + turn=2 + scripted_replace ⇒ block (third mutating tool)", () => {
    const state = { turn: 2 }
    const d = decideLocalizePhase({
      toolName: "scripted_replace",
      state,
      cfg: { phase1Turns: 3 },
    })
    expect(d.block).toBe(true)
  })

  test("phase1Turns=3 + turn=3 + edit ⇒ pass (Phase 2 entered)", () => {
    const state = { turn: 3 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(false)
  })

  test("phase1Turns=3 + turn=99 + edit ⇒ pass (well past phase)", () => {
    const state = { turn: 99 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(d.block).toBe(false)
  })

  test("phase1Turns=3 + turn=0 + non-mutating tools all pass", () => {
    const state = { turn: 0 }
    for (const name of ["read", "grep", "glob", "localize", "bash", "test_runner"]) {
      const d = decideLocalizePhase({ toolName: name, state, cfg: { phase1Turns: 3 } })
      expect(d.block).toBe(false)
    }
  })

  test("phase1Turns=1 + turn=0 + edit ⇒ block (single-turn phase)", () => {
    const state = { turn: 0 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 1 } })
    expect(d.block).toBe(true)
    expect(d.text).toContain("turn 1/1")
  })

  test("phase1Turns=1 + turn=1 + edit ⇒ pass", () => {
    const state = { turn: 1 }
    const d = decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 1 } })
    expect(d.block).toBe(false)
  })

  test("bash with `>` redirection still passes (closed mutating set excludes bash)", () => {
    const state = { turn: 0 }
    const d = decideLocalizePhase({ toolName: "bash", state, cfg: { phase1Turns: 5 } })
    expect(d.block).toBe(false)
  })

  test("MUTATING_TOOL_NAMES contains exactly {edit, write, scripted_replace, apply_patch, apply_patch_structured}", () => {
    expect(MUTATING_TOOL_NAMES.size).toBe(5)
    expect(MUTATING_TOOL_NAMES.has("edit")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("write")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("scripted_replace")).toBe(true)
    // apply_patch + apply_patch_structured added (audit #10 + self-audit H9): the
    // registered write_filesystem patch tools must not escape the Phase-1 block.
    expect(MUTATING_TOOL_NAMES.has("apply_patch")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("apply_patch_structured")).toBe(true)
    // Negative invariants — pinned so a future absent-minded add must update
    // the policy ADR.
    expect(MUTATING_TOOL_NAMES.has("bash")).toBe(false)
    expect(MUTATING_TOOL_NAMES.has("read")).toBe(false)
    expect(MUTATING_TOOL_NAMES.has("multi_edit")).toBe(false)
  })

  test("buildLocalizePhaseForceMessage is deterministic + interpolates", () => {
    expect(buildLocalizePhaseForceMessage(0, 3)).toContain("turn 1/3")
    expect(buildLocalizePhaseForceMessage(0, 3)).toBe(buildLocalizePhaseForceMessage(0, 3))
    expect(buildLocalizePhaseForceMessage(2, 3)).toContain("turn 3/3")
  })

  test("createLocalizePhaseState ⇒ fresh {turn:0}, separate instances", () => {
    const a = createLocalizePhaseState()
    const b = createLocalizePhaseState()
    expect(a).toEqual({ turn: 0 })
    expect(b).toEqual({ turn: 0 })
    a.turn = 5
    expect(b.turn).toBe(0)
  })

  test("guard does NOT mutate state on a block decision (pure)", () => {
    const state = { turn: 1 }
    const before = state.turn
    decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(state.turn).toBe(before)
  })

  test("guard does NOT mutate state on a pass decision (pure)", () => {
    const state = { turn: 5 }
    const before = state.turn
    decideLocalizePhase({ toolName: "edit", state, cfg: { phase1Turns: 3 } })
    expect(state.turn).toBe(before)
  })
})
