/**
 * ★ HELLGATE — apply_patch must NOT escape the Phase-1 localization block (audit #10).
 *
 * apply_patch (src/tool/apply-patch.ts, isReadOnly:()=>false, name "apply_patch")
 * is a REAL registered multi-file write tool that previously slipped past the
 * Phase-1 edit-block: the closed MUTATING_TOOL_NAMES set listed only edit/write/
 * scripted_replace, so the model could apply_patch the WRONG file before the
 * fault was localized. FIX: apply_patch is added EXPLICITLY to the closed set.
 *
 * Design note (why explicit-name-set, NOT raw isReadOnly): the gate
 * DELIBERATELY exempts `bash` (isReadOnly===false, but a huge legitimate
 * non-mutating surface — test runs, greps, reads). A capability rule of
 * "isReadOnly===false ⇒ block" would wrongly gate bash and break verify/repro.
 * So mutation here is decided by the auditable closed name set, and apply_patch
 * is added to it explicitly (the closed-set policy G-7a pins).
 *
 * ANTI-THEATER: against the unfixed set (apply_patch absent), the first
 * assertion returns {block:false} and FAILS; with apply_patch in the set it
 * blocks. The bash-exemption assertion FAILS against any "block all
 * non-read-only" mis-fix.
 */
import { describe, expect, test } from "bun:test"
import { decideLocalizePhase, MUTATING_TOOL_NAMES } from "../../src/agent/localize-phase-guard"

const CFG = { phase1Turns: 3 } as const
const PHASE1_STATE = { turn: 0 } as const
const PHASE2_STATE = { turn: 3 } as const

describe("localize-phase apply_patch escape (finding #10)", () => {
  test("apply_patch is BLOCKED during Phase 1 (was the escape)", () => {
    expect(decideLocalizePhase({ toolName: "apply_patch", state: PHASE1_STATE, cfg: CFG }).block).toBe(
      true,
    )
  })

  test("apply_patch is in the closed MUTATING_TOOL_NAMES set", () => {
    expect(MUTATING_TOOL_NAMES.has("apply_patch")).toBe(true)
  })

  test("the other registered edit tools stay blocked (no regression)", () => {
    for (const name of ["edit", "write", "scripted_replace"]) {
      expect(decideLocalizePhase({ toolName: name, state: PHASE1_STATE, cfg: CFG }).block).toBe(true)
    }
  })

  test("bash stays EXEMPT in Phase 1 (deliberate — a mis-fix gating all non-read-only tools breaks this)", () => {
    expect(decideLocalizePhase({ toolName: "bash", state: PHASE1_STATE, cfg: CFG }).block).toBe(false)
  })

  test("read-only exploration tools pass in Phase 1", () => {
    for (const name of ["read", "grep", "glob", "search_codebase", "localize"]) {
      expect(decideLocalizePhase({ toolName: name, state: PHASE1_STATE, cfg: CFG }).block).toBe(false)
    }
  })

  test("apply_patch passes in Phase 2 (block is phase-scoped, not a blanket ban)", () => {
    expect(decideLocalizePhase({ toolName: "apply_patch", state: PHASE2_STATE, cfg: CFG }).block).toBe(
      false,
    )
  })
})
