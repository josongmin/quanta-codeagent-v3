/**
 * Localize-phase guard — pure-policy unit tests (Agentless absorption — Tier 0).
 *
 * Pinned invariants:
 *   - Absent config ⇒ pass-through (byte-identical loop).
 *   - Invalid `phase1Turns` (0, -1, NaN, Infinity, non-integer) ⇒ guard OFF.
 *   - Within Phase 1 + mutating tool ⇒ block + Phase 1 reminder.
 *   - Within Phase 1 + non-mutating tool (read/grep/glob/localize/bash) ⇒ pass.
 *   - At phase boundary (turn === phase1Turns) ⇒ pass (Phase 2 entered).
 *   - Closed mutating set: { edit, write, scripted_replace }.
 */
import { describe, expect, test } from "bun:test"
import {
  buildLocalizePhaseForceMessage,
  createLocalizePhaseState,
  decideLocalizePhase,
  MUTATING_TOOL_NAMES,
} from "../../src/agent/localize-phase-guard"

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

  test("MUTATING_TOOL_NAMES contains exactly {edit, write, scripted_replace}", () => {
    expect(MUTATING_TOOL_NAMES.size).toBe(3)
    expect(MUTATING_TOOL_NAMES.has("edit")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("write")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("scripted_replace")).toBe(true)
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
