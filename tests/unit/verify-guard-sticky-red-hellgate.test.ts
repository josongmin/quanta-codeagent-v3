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
import {
  buildVerifyGuard,
  createVerifyGuardState,
  decideVerifyGuard,
  isVerifyOutputFailing,
  VERIFY_PASS_FORCE_MESSAGE,
} from "@/agent/verify-guard"

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

  test("EDIT IS NOT PROOF: red → edit → narrow green (red test never re-run) ⇒ BLOCK", () => {
    // Audit iter 6 (Attack AL): an edit after a regression red is a HYPOTHESIS,
    // not proof. The red test must be RE-RUN green to clear — editing (even the
    // fix) and then only running a narrow repro does NOT clear it. Anchoring at
    // the first edit (not the last) keeps the red in-window across the edit.
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "edit" }, // model edited again (maybe a fix, maybe not — unproven)
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
    expect(v.block).toBe(true) // RUNTESTS never re-run green ⇒ still unresolved
  })

  test("EDIT THEN RE-RUN GREEN clears it: red → edit → SAME command green ⇒ NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "edit" }, // the actual fix
      { name: "bash", arg: RUNTESTS, ok: true, output: "Ran 24 tests\n\nOK\n" }, // proof
    )
    expect(v.block).toBe(false)
  })

  test("PRE-FIX baseline red is excluded: repro red BEFORE first edit ⇒ not sticky", () => {
    // The initial failing reproduction (red before any edit) is the expected
    // baseline and must NOT block once a fix + green re-run land.
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "bash", arg: REPRO, ok: false, output: "1 failed" }, // pre-fix baseline
      { name: "edit" },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
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

// ────────────────────────────────────────────────────────────────────────
// Attack A (audit iter 1): exact-string keys false-BLOCK a correct re-run that
// varies the irrelevant env/cd wrapper. The real gpt-5.4 commands are
// `env VAR= ... uv run ... python tests/runtests.py X`, sometimes `cd repo &&`.
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — sticky key canonicalizes env/cd wrapper (no false-block on correct re-run)", () => {
  const RED = "env PYTEST_ADDOPTS= PYTHONNOUSERSITE=1 uv run --python 3.9 python tests/runtests.py migrations.test_loader"
  // Same test target, different wrapper: extra env var + a `cd` prefix + spacing.
  const GREEN_SAME = "cd /home/ubuntu/repo-AbC123 && env PYTHONNOUSERSITE=1 PYTEST_ADDOPTS=  uv run --python 3.9 python tests/runtests.py migrations.test_loader"

  test("re-run of the SAME test (different env/cd wrapper) GREEN clears the red ⇒ NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RED, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "edit" }, // model fixed the root cause
      { name: "bash", arg: GREEN_SAME, ok: true, output: "Ran 24 tests in 0.10s\n\nOK\n" },
    )
    expect(v.block).toBe(false)
  })

  test("SOUNDNESS: a DIFFERENT test target green does NOT clear the red (body preserved)", () => {
    const GREEN_OTHER = "env PYTHONNOUSERSITE=1 uv run --python 3.9 python tests/runtests.py migrations.test_state"
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RED, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: GREEN_OTHER, ok: true, output: "OK" },
    )
    expect(v.block).toBe(true) // different target ⇒ red still unresolved
  })
})

// ────────────────────────────────────────────────────────────────────────
// Attack F (audit iter 2): an unknown-outcome re-run (ok===undefined) must NOT
// clear a prior definitive red. A red is cleared only by a definitive GREEN.
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — unknown-outcome re-run does not wash out a definitive red", () => {
  test("red (ok:false) → SAME command re-run with unknown outcome (ok:undefined) ⇒ still BLOCK", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: RUNTESTS, output: "" }, // ok omitted ⇒ undefined: dispatch not resolved
    )
    expect(v.block).toBe(true)
  })

  test("red → SAME command re-run definitively GREEN (ok:true) ⇒ cleared, NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: RUNTESTS, ok: true, output: "OK" },
    )
    expect(v.block).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Attack U (audit iter 4): test_runner targets must not collapse — a green run
// of a DIFFERENT target must not wash out this red.
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — test_runner keys on target, not just tool name", () => {
  test("test_runner(A) RED → test_runner(B) GREEN (different target) ⇒ still BLOCK", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "test_runner", arg: "migrations.test_loader", ok: false, output: "FAILED (failures=1)" },
      { name: "test_runner", arg: "migrations.test_state", ok: true, output: "OK" },
    )
    expect(v.block).toBe(true)
  })

  test("test_runner(A) RED → test_runner(A) GREEN (same target) ⇒ cleared, NO block", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "test_runner", arg: "migrations.test_loader", ok: false, output: "FAILED (failures=1)" },
      { name: "test_runner", arg: "migrations.test_loader", ok: true, output: "OK" },
    )
    expect(v.block).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Attack AC/AE (audit iter 5): nested / interleaved cd+env prefixes must all
// peel so a correct re-run still matches its red.
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — canonicalize peels nested/interleaved cd+env prefixes", () => {
  const BODY = "python tests/runtests.py migrations.test_loader"
  test("nested cd + env: `cd a && cd b && env FOO=1 BODY` RED, `BODY` GREEN ⇒ cleared", () => {
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: `cd /a && cd /b && env FOO=1 ${BODY}`, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "edit" },
      { name: "bash", arg: BODY, ok: true, output: "OK" },
    )
    expect(v.block).toBe(false) // all prefixes peel ⇒ same key ⇒ red cleared
  })

  test("SOUNDNESS: `cd=1` (env var, no space) is NOT treated as a cd command", () => {
    // cd=1 must be stripped as a VAR assignment, leaving the body — and a
    // genuinely different body still must NOT clear.
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: `cd=1 ${BODY}`, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: "cd=1 python tests/runtests.py migrations.test_state", ok: true, output: "OK" },
    )
    expect(v.block).toBe(true) // different target ⇒ red stands
  })
})

describe("sanity — the real django runtests tail is recognized as failing output", () => {
  test("isVerifyOutputFailing matches `FAILED (failures=1)`", () => {
    expect(isVerifyOutputFailing("bash", RUNTESTS, DJANGO_FAIL_OUTPUT)).toBe(true)
  })
})

// buildVerifyGuard — the SINGLE shape constructor shared by the bench driver
// (reconcileBenchGuards) and the non-bench must-pass apply. Pins the exactOptional
// shape so optional fields are OMITTED (not set undefined) when absent.
describe("buildVerifyGuard — single shape SSOT", () => {
  test("minimal: only mustPass ⇒ no extra keys", () => {
    expect(buildVerifyGuard({ mustPass: false })).toEqual({ mustPass: false })
    expect("maxTrips" in buildVerifyGuard({ mustPass: false })).toBe(false)
    expect("exactCommands" in buildVerifyGuard({ mustPass: false })).toBe(false)
  })
  test("full: sticky + maxTrips + exactCommands all threaded", () => {
    expect(buildVerifyGuard({ mustPass: true, maxTrips: 2, stickyRed: true }, ["true"])).toEqual({
      mustPass: true,
      maxTrips: 2,
      stickyRed: true,
      exactCommands: ["true"],
    })
  })
  test("stickyRed:false is OMITTED (not set false)", () => {
    expect("stickyRed" in buildVerifyGuard({ mustPass: true, stickyRed: false })).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Messaging fix — the 2nd gap found by the django-11141 cassette audit: the
// model dismissed the generic "test/repro failed" nudge by pointing at its
// green repro. The stickyRed message MUST name the unresolved command and deny
// the different-check escape.
// ────────────────────────────────────────────────────────────────────────
describe("HELLGATE — stickyRed block message names the command + closes the repro escape", () => {
  const block = decide(
    { mustPass: true, maxTrips: 2, stickyRed: true },
    { name: "edit" },
    { name: "bash", arg: RUNTESTS, ok: false, output: DJANGO_FAIL_OUTPUT },
    { name: "bash", arg: REPRO, ok: true, output: "1 passed in 0.17s" },
  )

  test("blocks AND the message quotes the unresolved command (not the green repro)", () => {
    expect(block.block).toBe(true)
    expect(block.text).toContain(RUNTESTS) // names the still-red command
    expect(block.text).not.toContain(REPRO) // does not point at the green check
  })

  test("message shows the CANONICAL command (env/cd wrapper stripped)", () => {
    const RED_WRAPPED =
      "cd /home/ubuntu/repo-XyZ && env PYTEST_ADDOPTS= PYTHONNOUSERSITE=1 uv run python tests/runtests.py migrations.test_loader"
    const v = decide(
      { mustPass: true, maxTrips: 2, stickyRed: true },
      { name: "edit" },
      { name: "bash", arg: RED_WRAPPED, ok: false, output: DJANGO_FAIL_OUTPUT },
      { name: "bash", arg: REPRO, ok: true, output: "1 passed" },
    )
    expect(v.block).toBe(true)
    expect(v.text).toContain("uv run python tests/runtests.py migrations.test_loader")
    expect(v.text).not.toContain("cd /home/ubuntu/repo-XyZ") // wrapper stripped from the shown command
    expect(v.text).not.toContain("PYTEST_ADDOPTS")
  })

  test("message explicitly denies the 'a different check passed' escape", () => {
    // The exact escape the gpt-5.4 run exploited must be shut: a different
    // (narrower) green does not clear the red.
    expect(block.text?.toLowerCase()).toContain("different check passing")
    expect(block.text?.toLowerCase()).toContain("does not clear")
  })

  test("RED-ON-INJECTION: the generic non-sticky message is NOT what stickyRed emits", () => {
    // If a refactor routes stickyRed back through verifyPassForceMessage, the
    // command name vanishes and this goes RED.
    expect(block.text).not.toBe(VERIFY_PASS_FORCE_MESSAGE)
  })
})
