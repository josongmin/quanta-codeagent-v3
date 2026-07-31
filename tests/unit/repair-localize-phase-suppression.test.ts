/**
 * Repair-round localize-phase EDIT-BLOCK suppression (jun-25).
 *
 * THE STRAITJACKET BEING FIXED: the localize-phase guard denies mutating tools
 * for the first `phase1Turns` of a session ("localize first"). A REPAIR round
 * spins a FRESH agent session (turn 0) but the fault is already localized by
 * construction (the patch exists, the failing gate is named, and the repair seed
 * says "revise the patch now / repair_existing_patch_only"). Before this fix the
 * edit-block re-fired every repair round, so the model was told to fix the patch
 * AND forbidden to edit — wasting ~5 turns/round re-localizing.
 *
 * THE FIX (`repairLocalizePhaseSuppressed`): strip `phase1Turns` from the repair
 * posture's `localizePhase` so `buildLocalizePhase` returns `undefined` (no
 * state ⇒ `decideLocalizePhase` never blocks), while PRESERVING the advisory
 * `lspGroundingSteer` field. INITIAL generation keeps the block (paired control).
 *
 * TEETH: removing the `phase1Turns` strip in `repairLocalizePhaseSuppressed`
 * makes "REPAIR: mutating edit is NOT denied" go RED (the guard would re-block).
 */

import { describe, expect, test } from "bun:test"
import { decideLocalizePhase } from "../../src/agent/localize-phase-guard"
import { buildLocalizePhase } from "../../src/agent/session-resources"
import { repairLocalizePhaseSuppressed } from "../../src/runner/batch/eval/driver"
import { benchPostureFromState, resolveBenchKnobs } from "../../src/runner/batch/eval/knobs-bench"

/** A bench posture with localize-phase ACTIVE (and LSP nav on so the advisory
 *  grounding steer rides on the same `localizePhase` object). Built through the
 *  REAL resolver, not a hand-assembled literal, so the test pins the shape the
 *  driver actually produces. */
const activePosture = () =>
  benchPostureFromState(
    resolveBenchKnobs({
      envVars: {
        QUANTA_BENCH_LOCALIZE_PHASE: "5",
        QUANTA_BENCH_LSP: "1",
      } as NodeJS.ProcessEnv,
    }),
    { QUANTA_BENCH_LSP: "1" } as NodeJS.ProcessEnv,
  )

/** Build the AgentConfig-level localize-phase STATE + run the guard for an
 *  `edit` at the given turn — exactly the chain the dispatch consult uses
 *  (`buildLocalizePhase` → `decideLocalizePhase`). */
const editBlockedAtTurn = (
  localizePhase: ReturnType<typeof activePosture>["localizePhase"],
  turn: number,
): boolean => {
  // `buildLocalizePhase` only allocates state when phase1Turns is a positive
  // integer — i.e. it mirrors the guard's active-domain gate.
  const state = buildLocalizePhase({ localizePhase } as never)
  const decision = decideLocalizePhase({
    toolName: "edit",
    state: state === undefined ? undefined : { turn },
    cfg: localizePhase,
  })
  return decision.block
}

describe("repair localize-phase suppression (jun-25 straitjacket fix)", () => {
  test("PRECONDITION: localize-phase is genuinely active in the base posture", () => {
    const opt = activePosture()
    expect(opt.localizePhase).toBeDefined()
    expect(opt.localizePhase?.phase1Turns).toBe(5)
  })

  // ── INITIAL generation (paired control — UNCHANGED) ──────────────────────
  test("INITIAL: a mutating edit IS denied during phase-1 (turn 0)", () => {
    const opt = activePosture()
    expect(editBlockedAtTurn(opt.localizePhase, 0)).toBe(true)
  })

  test("INITIAL: still denied at the last phase-1 turn (turn 4 of 5)", () => {
    const opt = activePosture()
    expect(editBlockedAtTurn(opt.localizePhase, 4)).toBe(true)
  })

  test("INITIAL: phase-2 turn (turn 5) passes through (unchanged boundary)", () => {
    const opt = activePosture()
    expect(editBlockedAtTurn(opt.localizePhase, 5)).toBe(false)
  })

  // ── REPAIR round (suppressed — the fix) ──────────────────────────────────
  test("REPAIR: a mutating edit is NOT denied at turn 0 (block suppressed)", () => {
    const repair = repairLocalizePhaseSuppressed(activePosture())
    // TEETH: if `repairLocalizePhaseSuppressed` did not strip `phase1Turns`,
    // this would re-block exactly like the INITIAL turn-0 control above.
    expect(editBlockedAtTurn(repair.localizePhase, 0)).toBe(false)
  })

  test("REPAIR: edit allowed at every would-be phase-1 turn (0..4)", () => {
    const repair = repairLocalizePhaseSuppressed(activePosture())
    for (let turn = 0; turn < 5; turn++) {
      expect(editBlockedAtTurn(repair.localizePhase, turn)).toBe(false)
    }
  })

  test("REPAIR: buildLocalizePhase allocates NO state (guard fully off)", () => {
    const repair = repairLocalizePhaseSuppressed(activePosture())
    expect(buildLocalizePhase({ localizePhase: repair.localizePhase } as never)).toBeUndefined()
  })

  // ── advisory steer PRESERVED (decouple block from steer) ──────────────────
  test("REPAIR: the advisory lspGroundingSteer survives suppression", () => {
    const opt = activePosture()
    expect(opt.localizePhase?.lspGroundingSteer).toBe(true)
    const repair = repairLocalizePhaseSuppressed(opt)
    expect(repair.localizePhase?.lspGroundingSteer).toBe(true)
    // …but phase1Turns is gone — the hard block is what we dropped.
    expect(repair.localizePhase?.phase1Turns).toBeUndefined()
  })

  // ── byte-identical fences ────────────────────────────────────────────────
  test("byte-identical: INITIAL posture object is not mutated by suppression", () => {
    const opt = activePosture()
    const before = opt.localizePhase?.phase1Turns
    repairLocalizePhaseSuppressed(opt)
    expect(opt.localizePhase?.phase1Turns).toBe(before)
    expect(opt.localizePhase?.phase1Turns).toBe(5)
  })

  test("byte-identical: posture WITHOUT localize-phase passes through unchanged", () => {
    const noLp = benchPostureFromState(
      resolveBenchKnobs({ envVars: {} as NodeJS.ProcessEnv }),
      {} as NodeJS.ProcessEnv,
    )
    expect(noLp.localizePhase).toBeUndefined()
    expect(repairLocalizePhaseSuppressed(noLp)).toBe(noLp)
  })

  test("non-edit (read) is never blocked in INITIAL or REPAIR", () => {
    const opt = activePosture()
    const readInitial = decideLocalizePhase({
      toolName: "read",
      state: { turn: 0 },
      cfg: opt.localizePhase,
    })
    expect(readInitial.block).toBe(false)
    const repair = repairLocalizePhaseSuppressed(opt)
    const readRepair = decideLocalizePhase({
      toolName: "read",
      state: { turn: 0 },
      cfg: repair.localizePhase,
    })
    expect(readRepair.block).toBe(false)
  })
})
