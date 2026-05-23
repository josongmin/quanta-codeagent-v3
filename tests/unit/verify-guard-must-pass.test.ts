/**
 * `decideVerifyGuard` mustPass branch tests (ADR-0011 outcome-gate extension).
 *
 * Establishes:
 *   (a) byte-identical behavior with `mustPass:false`/absent (the legacy
 *       presence-only contract — assert via cross-check against the legacy
 *       suite's expected outcomes for the same inputs).
 *   (b) the mustPass branch fires ONLY when (i) presence is satisfied AND
 *       (ii) the latest verify after the latest edit failed.
 *   (c) `state.trips` is shared by both branches (one budget).
 *   (d) Conservative posture on unknown outcome (ok absent + output absent
 *       ⇒ pass-through, not block).
 *
 * The recognizer-level tests for the failure-output registry live in
 * `verify-signal-outcome.test.ts`; here we drive `decideVerifyGuard` directly
 * so the gating decision is what we assert.
 */
import { describe, expect, test } from "bun:test"
import {
  createVerifyGuardState,
  decideVerifyGuard,
  VERIFY_FORCE_MESSAGE,
  VERIFY_PASS_FORCE_MESSAGE,
} from "@/agent/verify-guard"

type Entry = { name: string; arg?: string; id?: string; ok?: boolean; output?: string }
const h = (...items: Entry[]): readonly Entry[] => items

describe("mustPass:false (default) — byte-identical with legacy presence-only", () => {
  test("edit then nothing ⇒ block (presence)", () => {
    const state = createVerifyGuardState()
    expect(decideVerifyGuard({ history: h({ name: "edit" }), cfg: {}, state })).toEqual({
      block: true,
      text: VERIFY_FORCE_MESSAGE,
    })
  })

  test("edit then test_runner ok:false ⇒ NO block (legacy presence-only)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg: {},
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("edit then test_runner ok:false ⇒ NO block when mustPass:false explicit", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg: { mustPass: false },
        state,
      }),
    ).toEqual({ block: false })
  })
})

describe("mustPass:true — outcome-gate", () => {
  test("edit then test_runner ok:true ⇒ no block (verify passed)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: true }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("edit then test_runner ok:false ⇒ BLOCK with PASS_FORCE message", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: true, text: VERIFY_PASS_FORCE_MESSAGE })
    expect(state.trips).toBe(1)
  })

  test("edit then pytest ok:true BUT output contains `FAILED` ⇒ BLOCK", () => {
    const state = createVerifyGuardState()
    const verdict = decideVerifyGuard({
      history: h(
        { name: "edit" },
        {
          name: "bash",
          arg: "pytest tests/test_x.py",
          ok: true,
          output: "FAILED tests/test_x.py::test_y - AssertionError",
        },
      ),
      cfg: { mustPass: true },
      state,
    })
    expect(verdict.block).toBe(true)
    expect(verdict.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
    expect(state.trips).toBe(1)
  })

  test("edit then pytest ok:true with empty output ⇒ NO block (conservative)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "bash", arg: "pytest", ok: true, output: "" }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("edit then pytest with ok absent + output absent ⇒ NO block (unknown ⇒ pass)", () => {
    // Conservative: outcome unknown (legacy push-only-on-start) ⇒ do not over-
    // block. mustPass is additive — it only fires on a CLEAR failure signal.
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "bash", arg: "pytest" }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("edit then verify ok:false ⇒ block; second finish with same history ⇒ cap reached", () => {
    const state = createVerifyGuardState()
    const cfg = { mustPass: true, maxTrips: 1 }
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg,
        state,
      }),
    ).toEqual({ block: true, text: VERIFY_PASS_FORCE_MESSAGE })
    expect(state.trips).toBe(1)

    // Second attempt with the SAME history (still failing) ⇒ cap reached.
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg,
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(1)
  })

  test("maxTrips:2 — presence then mustPass each consume one slot", () => {
    const state = createVerifyGuardState()
    const cfg = { mustPass: true, maxTrips: 2 }
    // Step 1: edit only → presence fires.
    expect(decideVerifyGuard({ history: h({ name: "edit" }), cfg, state }).block).toBe(true)
    expect(state.trips).toBe(1)
    // Step 2: edit + verify ok:false → mustPass fires (different slot).
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg,
        state,
      }).block,
    ).toBe(true)
    expect(state.trips).toBe(2)
    // Step 3: cap reached.
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg,
        state,
      }).block,
    ).toBe(false)
    expect(state.trips).toBe(2)
  })

  test("the MOST RECENT verify wins: first fails, second passes ⇒ no block", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h(
          { name: "edit" },
          { name: "test_runner", ok: false },
          { name: "test_runner", ok: true },
        ),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("the MOST RECENT verify wins: first passes, second fails ⇒ block", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h(
          { name: "edit" },
          { name: "test_runner", ok: true },
          { name: "test_runner", ok: false },
        ),
        cfg: { mustPass: true },
        state,
      }).block,
    ).toBe(true)
  })

  test("verify BEFORE the latest edit doesn't count (presence still fires)", () => {
    // edit, verify(pass), EDIT, finish → no verify after second edit ⇒
    // presence branch fires (VERIFY_FORCE_MESSAGE), not mustPass.
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: true }, { name: "edit" }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE })
  })

  test("bash noise (echo done) after edit ⇒ presence fires (noise ≠ verify)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "bash", arg: "echo done", ok: true, output: "done" }),
        cfg: { mustPass: true },
        state,
      }),
    ).toEqual({ block: true, text: VERIFY_FORCE_MESSAGE })
  })
})

describe("mustPass: shape compatibility", () => {
  test("cfg undefined ⇒ guard fully OFF (mustPass irrelevant)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg: undefined,
        state,
      }),
    ).toEqual({ block: false })
    expect(state.trips).toBe(0)
  })

  test("cfg empty ({}) ⇒ mustPass defaults to off, presence-only", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({
        history: h({ name: "edit" }, { name: "test_runner", ok: false }),
        cfg: {},
        state,
      }),
    ).toEqual({ block: false })
  })
})
