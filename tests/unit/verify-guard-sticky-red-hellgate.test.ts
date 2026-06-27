/**
 * ★ CONTRACT — verify-guard `stickyRed` (jun-27, django-11141 gpt-5.4 RCA).
 *
 *   The latest-verify-only mustPass gate (`decideVerifyGuard` without
 *   `stickyRed`) can be defeated by running a DIFFERENT green command after a
 *   red: a narrow repro green washes out a broad regression red, and closeout
 *   is allowed with the regression still live. This is the EXACT failure mode
 *   observed on django__django-11141 with gpt-5.4 (RUN trajectory:
 *     edit loader.py  →  runtests.py migrations.test_loader  → FAIL
 *                         (test_load_empty_dir regressed)
 *                      →  python reproduce_issue.py          → PASS
 *                      →  finish  ⇒  shipped the regressed patch).
 *
 *   With `stickyRed:true` a failing verify is STICKY: only a later PASSING run
 *   of the SAME command clears it. A green run of a different command does not.
 *
 *   These assertions call the real `decideVerifyGuard` — no reimplementation.
 *   The OFF arm pins byte-identical legacy behavior (the leak persists), so the
 *   contract proves the fix is the `stickyRed` flag and nothing else.
 */

import { describe, expect, test } from "bun:test"
import { createVerifyGuardState, decideVerifyGuard, isVerifyOutputFailing } from "@/agent/verify-guard"

type Entry = { name: string; arg?: string; id?: string; ok?: boolean; output?: string }
const h = (...items: Entry[]): readonly Entry[] => items

const decide = (
  cfg: { mustPass: boolean; maxTrips?: number; stickyRed?: boolean },
  ...items: Entry[]
): ReturnType<typeof decideVerifyGuard> =>
  decideVerifyGuard({ history: h(...items), cfg, state: createVerifyGuardState() })

const RUNTESTS = "python tests/runtests.py migrations.test_loader --settings=test_sqlite"
const REPRO = "python -s reproduce_issue.py"

// The verbatim django runtests failure tail from the real gpt-5.4 RUN.
const DJANGO_FAIL_OUTPUT =
  "Creating test database for alias 'default'...\n" +
  "......F.................\n" +
  "FAIL: test_load_empty_dir (migrations.test_loader.LoaderTests)\n" +
  "Ran 24 tests in 0.107s\n\nFAILED (failures=1)\n"

describe("HELLGATE — stickyRed closes the narrow-green-washes-broad-red leak", () => {
  test("MOTIVATING (django-11141): edit → runtests FAIL → repro PASS → finish ⇒ BLOCK", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed in 0.17s" },
    )
    expect(v.block).toBe(true)
  })

  test("RED-ON-INJECTION: the SAME sequence with stickyRed OFF does NOT block (legacy leak persists)", () => {
    // This is the bug. If a future refactor makes the default branch sticky,
    // this assertion goes RED — forcing the change to stay opt-in (byte-identical
    // default per the DEFAULT-OFF invariant).
    const v = decide(
      { mustPass: true, maxTrips: 2 }, // no stickyRed
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed in 0.17s" },
    )
    expect(v.block).toBe(false)
  })

  test("CLEARED: re-running the SAME command green clears the red ⇒ NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: RUNTESTS, ok: true, output: "Ran 24 tests in 0.10s\n\nOK\n" },
    )
    expect(v.block).toBe(false)
  })

  test("STILL-RED: command A passes but command B's latest run failed ⇒ BLOCK on B", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: "pytest tests/test_a.py", ok: true, output: "1 passed" },
      { name: "bash", arg: "pytest tests/test_b.py", ok: false, output: "1 failed" },
      { name: "bash", arg: "pytest tests/test_a.py", ok: true, output: "1 passed" },
    )
    expect(v.block).toBe(true)
  })

  test("EDIT RESETS WINDOW: red before the LATEST edit is not sticky (model re-edited)", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "edit" }, // model went back to fix
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
    // Only the post-edit window counts; after the 2nd edit no verify failed.
    // (presence is satisfied by the repro run.)
    expect(v.block).toBe(false)
  })

  test("ALL GREEN: distinct green commands, none failing ⇒ NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: true, output: "OK" },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
    expect(v.block).toBe(false)
  })

  test("PRESENCE still fires under stickyRed: edit with NO verify after ⇒ BLOCK", () => {
    const v = decide({ mustPass: true, maxTrips: 2, stickyRed: true }, { name: "edit" })
    expect(v.block).toBe(true)
  })

  test("maxTrips budget is respected: stickyRed blocks at most `maxTrips` times", () => {
    const state = createVerifyGuardState()
    const hist = h(
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
    const cfg = { mustPass: true, maxTrips: 1, stickyRed: true }
    expect(decideVerifyGuard({ history: hist, cfg, state }).block).toBe(true)
    // budget spent ⇒ second call allows finish (no infinite loop)
    expect(decideVerifyGuard({ history: hist, cfg, state }).block).toBe(false)
  })
})

describe("sanity — the real django runtests tail is recognized as failing output", () => {
  test("isVerifyOutputFailing matches `FAILED (failures=1)`", () => {
    expect(isVerifyOutputFailing("bash", RUNTESTS, DJANGO_FAIL_OUTPUT)).toBe(true)
  })
})
