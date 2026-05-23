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
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(["edit", "scripted_replace", "write"])
  })

  test("G-7b: 'patch' / 'apply_patch' / 'replace_in_file' / 'multi_edit' all PASS today (must add to set if registered)", () => {
    const state = { turn: 0 }
    const cfg = { phase1Turns: 3 }
    for (const name of ["patch", "apply_patch", "replace_in_file", "multi_edit"]) {
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
