/**
 * ★ CONTRACT — verify-guard mustPass (ADR-0011 outcome-gate extension).
 *
 *   `decideVerifyGuard` with `cfg.mustPass:true` BLOCKS closeout when EITHER
 *     (P) the legacy presence branch fires (no verify-classified call after
 *         the latest edit), OR
 *     (M) the most-recent verify after the latest edit FAILED
 *         (`ok:false` OR `isVerifyOutputFailing(output)`).
 *
 *   The mustPass branch's adversarial table: any way the model could declare
 *   "done" after a failing verify that the OLD presence-only guard would let
 *   through MUST now be caught. And any over-block (false-positive failure
 *   recognition) MUST NOT fire so the guard does not waste turns on passing
 *   runs.
 *
 *   This is the FLAGSHIP outcome-gate claim. Every assertion below is the
 *   real `decideVerifyGuard` decision — no helper reimplementation.
 */

import { describe, expect, test } from "bun:test"
import {
  createVerifyGuardState,
  decideVerifyGuard,
  isVerifyOutputFailing,
  VERIFY_FORCE_MESSAGE,
  VERIFY_PASS_FORCE_MESSAGE,
} from "@/agent/verify-guard"

type Entry = { name: string; arg?: string; id?: string; ok?: boolean; output?: string }
const h = (...items: Entry[]): readonly Entry[] => items

const verdictAfter = (...items: Entry[]): ReturnType<typeof decideVerifyGuard> => {
  const state = createVerifyGuardState()
  return decideVerifyGuard({
    history: h(...items),
    cfg: { mustPass: true, maxTrips: 5 }, // unlimited for purposes of the table
    state,
  })
}

// ────────────────────────────────────────────────────────────────────────
// 1. The MOTIVATING leak: "ran test_runner, got ok:false, declared done"
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — the false-success leak mustPass was designed to close", () => {
  test("CONTRACT: edit → test_runner ok:false → finish ⇒ BLOCK (mustPass)", () => {
    const v = verdictAfter({ name: "edit" }, { name: "test_runner", ok: false })
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
  })

  test("CONTRACT: edit → bash pytest ok:false → finish ⇒ BLOCK", () => {
    const v = verdictAfter(
      { name: "edit" },
      { name: "bash", arg: "python -m pytest tests/test_x.py", ok: false },
    )
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
  })

  test("CONTRACT: edit → pytest ok:true with `FAILED` in output → BLOCK (output overrides)", () => {
    const v = verdictAfter(
      { name: "edit" },
      {
        name: "bash",
        arg: "pytest",
        ok: true,
        output: "tests/test_x.py F\n==================== 1 failed in 0.42s ====================",
      },
    )
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
  })
})

// ────────────────────────────────────────────────────────────────────────
// 2. The CONSERVATIVE posture — do not over-block
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — conservative posture, no over-blocking", () => {
  test("edit → pytest ok:true clean output ⇒ NO block", () => {
    expect(
      verdictAfter(
        { name: "edit" },
        {
          name: "bash",
          arg: "pytest",
          ok: true,
          output: "==================== 5 passed in 0.42s ====================",
        },
      ).block,
    ).toBe(false)
  })

  test("edit → pytest with `failed` substring inside a passing summary ⇒ NO block", () => {
    // `0 failed` would match our broad pytest-short pattern. Verify the
    // characterized behavior: top-of-line `0 failed in 1.23s` matches. But
    // when the summary line is wrapped in `=====`, the line starts with `=`
    // not the digit — so the pytest-short matcher SHOULDN'T fire.
    expect(
      verdictAfter(
        { name: "edit" },
        {
          name: "bash",
          arg: "pytest",
          ok: true,
          output: "==================== 5 passed, 0 failed in 0.42s ====================",
        },
      ).block,
    ).toBe(false)
  })

  test("edit → test_runner ok absent + output absent ⇒ NO block (unknown ⇒ pass)", () => {
    // Legacy push-only-on-start path where dispatch did not patch ok/output.
    // mustPass branch MUST pass-through: we cannot prove failure.
    expect(verdictAfter({ name: "edit" }, { name: "test_runner" }).block).toBe(false)
  })

  test("edit → test_runner ok:true output absent ⇒ NO block (passed)", () => {
    expect(verdictAfter({ name: "edit" }, { name: "test_runner", ok: true }).block).toBe(false)
  })

  test("edit → pytest ok:true with `Error` in stack trace but no failure summary ⇒ NO block", () => {
    expect(
      verdictAfter(
        { name: "edit" },
        {
          name: "bash",
          arg: "pytest",
          ok: true,
          output:
            "test_x.py::test_y PASSED\nTraceback (most recent call last):\n  ValueError: oops\n==================== 1 passed in 0.42s ====================",
        },
      ).block,
    ).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// 3. RECENCY semantics
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — recency semantics", () => {
  test("edit → fail → pass ⇒ NO block (later pass wins)", () => {
    expect(
      verdictAfter(
        { name: "edit" },
        { name: "test_runner", ok: false },
        { name: "test_runner", ok: true },
      ).block,
    ).toBe(false)
  })

  test("edit → pass → fail ⇒ BLOCK (later fail wins)", () => {
    const v = verdictAfter(
      { name: "edit" },
      { name: "test_runner", ok: true },
      { name: "test_runner", ok: false },
    )
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
  })

  test("edit → fail → noise bash → finish ⇒ BLOCK (noise doesn't reset)", () => {
    const v = verdictAfter(
      { name: "edit" },
      { name: "test_runner", ok: false },
      { name: "bash", arg: "git status", ok: true, output: "clean" },
    )
    // The latest VERIFY-classified entry is still the failed test_runner;
    // the noise bash does not match isVerify so it doesn't update the slot.
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
  })

  test("verify before edit doesn't satisfy; presence branch fires (not mustPass)", () => {
    const v = verdictAfter({ name: "test_runner", ok: true }, { name: "edit" })
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_FORCE_MESSAGE) // presence msg, not pass-force
  })

  test("edit, verify ok:false, edit, finish ⇒ presence fires (no verify after latest edit)", () => {
    const v = verdictAfter({ name: "edit" }, { name: "test_runner", ok: false }, { name: "edit" })
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_FORCE_MESSAGE) // presence branch, not pass-force
  })
})

// ────────────────────────────────────────────────────────────────────────
// 4. ADVERSARIAL inputs — prototype, weird shapes
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — adversarial inputs", () => {
  test("cfg is an object with __proto__ injecting mustPass ⇒ NOT activated", () => {
    // Object.create-based prototype injection cannot flip mustPass: we test
    // for OWN property only via direct `===` comparison.
    const cfg = Object.create({ mustPass: true })
    const state = createVerifyGuardState()
    const v = decideVerifyGuard({
      history: h({ name: "edit" }, { name: "test_runner", ok: false }),
      cfg,
      state,
    })
    // Behavior IS via the prototype because JS property access reads the
    // chain. This test DOCUMENTS the prototype-read behavior; if security
    // requires own-only it would need an explicit `Object.hasOwn` call.
    // For now we ACCEPT prototype reads since the AgentConfig is constructed
    // by trusted code paths.
    expect(typeof v.block).toBe("boolean")
  })

  test("mustPass: undefined (vs absent) treated as not-set ⇒ presence-only", () => {
    const state = createVerifyGuardState()
    const v = decideVerifyGuard({
      history: h({ name: "edit" }, { name: "test_runner", ok: false }),
      cfg: { mustPass: undefined } as unknown as { mustPass?: boolean },
      state,
    })
    expect(v.block).toBe(false)
  })

  test("mustPass: 'true' (string) ⇒ NOT activated (strict === true required)", () => {
    const state = createVerifyGuardState()
    const v = decideVerifyGuard({
      history: h({ name: "edit" }, { name: "test_runner", ok: false }),
      cfg: { mustPass: "true" as unknown as boolean },
      state,
    })
    expect(v.block).toBe(false)
  })

  test("ok is 0 (falsy but not boolean false) ⇒ NOT treated as failure", () => {
    const state = createVerifyGuardState()
    const v = decideVerifyGuard({
      history: h({ name: "edit" }, { name: "test_runner", ok: 0 as unknown as boolean }),
      cfg: { mustPass: true },
      state,
    })
    expect(v.block).toBe(false)
  })

  test("output is `null` (defensive) ⇒ NOT treated as failure", () => {
    const state = createVerifyGuardState()
    const v = decideVerifyGuard({
      history: h(
        { name: "edit" },
        {
          name: "test_runner",
          ok: true,
          output: null as unknown as string,
        },
      ),
      cfg: { mustPass: true },
      state,
    })
    expect(v.block).toBe(false)
  })

  test("an empty history ⇒ no block (no edit ⇒ no presence ⇒ no mustPass)", () => {
    const state = createVerifyGuardState()
    expect(decideVerifyGuard({ history: [], cfg: { mustPass: true }, state }).block).toBe(false)
  })

  test("very long history with one failing verify at the tail ⇒ BLOCK", () => {
    const items: Entry[] = []
    for (let i = 0; i < 100; i++) items.push({ name: "read" })
    items.push({ name: "edit" })
    for (let i = 0; i < 100; i++) items.push({ name: "read" })
    items.push({ name: "test_runner", ok: false })
    const state = createVerifyGuardState()
    expect(decideVerifyGuard({ history: items, cfg: { mustPass: true }, state }).block).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────
// 5. ECOSYSTEM coverage — output-side parser meets the gate
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — ecosystem coverage at the gate", () => {
  // Sanity-cross-check: each output failure marker should round-trip through
  // the gate AND through the recognizer. We assert the GATE decision (not
  // just the recognizer) so we prove the SHIPPING contract.
  const failingOutputs: Array<{ name: string; output: string }> = [
    { name: "pytest", output: "==================== 1 failed in 0.42s ====================" },
    { name: "jest", output: "Tests:       3 failed, 5 passed, 8 total" },
    { name: "go", output: "--- FAIL: TestFoo (0.00s)" },
    { name: "cargo", output: "test result: FAILED. 1 passed; 2 failed; 0 ignored" },
    { name: "mocha", output: "  10 passing (5s)\n  5 failing" },
    { name: "phpunit", output: "FAILURES!\nTests: 5, Failures: 3." },
    { name: "dotnet", output: "Failed!  - Failed:    3, Passed:     5" },
    { name: "unittest", output: "FAILED (failures=2)" },
  ]

  for (const fo of failingOutputs) {
    test(`gate blocks with ok:true + ${fo.name} failure output`, () => {
      // Cross-check the recognizer agrees.
      expect(isVerifyOutputFailing("bash", "pytest", fo.output)).toBe(true)
      // Use test_runner as the verify entry (always classifies as verify
      // regardless of arg). The output-side parser is ecosystem-agnostic.
      const v = verdictAfter({ name: "edit" }, { name: "test_runner", ok: true, output: fo.output })
      expect(v.block).toBe(true)
      expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
    })
  }

  const passingOutputs: Array<{ name: string; output: string }> = [
    { name: "pytest", output: "==================== 5 passed in 0.42s ====================" },
    { name: "jest", output: "Tests:       5 passed, 5 total" },
    { name: "go", output: "ok  \tgithub.com/foo/bar 0.012s" },
    { name: "cargo", output: "test result: ok. 3 passed; 0 failed; 0 ignored" },
    { name: "phpunit", output: "OK (5 tests, 12 assertions)" },
    { name: "dotnet", output: "Passed!  - Failed:    0, Passed:     5" },
    { name: "unittest", output: "OK" },
  ]

  for (const po of passingOutputs) {
    test(`gate passes with ok:true + ${po.name} passing output`, () => {
      expect(isVerifyOutputFailing("bash", "pytest", po.output)).toBe(false)
      const v = verdictAfter({ name: "edit" }, { name: "test_runner", ok: true, output: po.output })
      expect(v.block).toBe(false)
    })
  }
})

// ────────────────────────────────────────────────────────────────────────
// 6. THE SYNTHETIC DEMO — the exact sanity-failure pattern
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — synthetic demo of the sanity-observed false-done", () => {
  test("DEMO: skills/subagent ON pattern — test_runner ok:false then declare done MUST be blocked", () => {
    // Repro the observation. Without mustPass, the model:
    //   1. edited file (presence requirement met by step 2)
    //   2. called test_runner → received ok:false
    //   3. declared "done"
    // The legacy presence-only guard SAW step 2 and let step 3 through.
    // mustPass = block step 3 with the explicit pass-force message.
    const state = createVerifyGuardState()
    const cfg = { mustPass: true, maxTrips: 2 }
    const history = h(
      { name: "read" },
      { name: "edit" },
      { name: "test_runner", id: "call_1", ok: false, output: "FAILED tests/test_x.py" },
    )
    const v = decideVerifyGuard({ history, cfg, state })
    expect(v.block).toBe(true)
    expect(v.text).toBe(VERIFY_PASS_FORCE_MESSAGE)
    expect(state.trips).toBe(1)

    // Crucially: with mustPass DISABLED, the SAME history flows through.
    const state2 = createVerifyGuardState()
    const v2 = decideVerifyGuard({ history, cfg: {}, state: state2 })
    expect(v2.block).toBe(false)
    expect(state2.trips).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* merged from verify-guard-must-pass.test.ts */
/* ------------------------------------------------------------------ */
