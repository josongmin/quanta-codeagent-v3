/**
 * Bug-bash (jun-20) grading-group fixes — teeth on three correctness defects.
 * Each test FAILS if its fix is reverted (red-on-injection), observing the
 * real grading outcome / classification, not a mock asserting itself.
 *
 *   #28 endReasonOf ignored InstanceResult.stopReason ⇒ no_patch_exhausted
 *       was systematically 0 on the single-attempt path (no budget stamped).
 *   #29 PASS_SUMMARY_RE matched "0 passed" ⇒ a zero-test / SIGTERM'd run
 *       graded a false GREEN.
 *   #30 unanchored generic error/failure-count matchers flipped a real PASS
 *       to fail-closed on incidental "N errors" prose.
 */
import { describe, expect, test } from "bun:test"
import { isVerifyOutputFailing, isVerifyOutputPassing } from "@/agent/verify-signal"
import { buildFacts } from "@/runner/batch/eval/closure-diagnostics-io"
import { verify } from "@/runner/batch/eval/verdict"
import type { Instance, InstanceResult } from "@/runner/batch/types"

// A non-swebench instance whose `testCmd` is a real shell script (the local
// testCmd grading path). `sandbox`/`repoPath` are unused by the script.
const localInstance = (testCmd: string): Instance => ({
  id: "local",
  repoPath: "/tmp",
  problemStatement: "x",
  testCmd,
})

const runVerify = (testCmd: string) =>
  verify(localInstance(testCmd), "diff --git a/x b/x\n", process.cwd(), { timeoutMs: 10_000 })

describe("bugbash grading fixes", () => {
  // ── #28: stopReason fallback in endReasonOf ────────────────────────────────
  test("#28 single-attempt max_turns empty patch classifies no_patch_exhausted", () => {
    // No `budget` (single-attempt path stamps none) — only stopReason is set.
    const r: InstanceResult = {
      id: "stuck",
      passed: false,
      patch: "",
      turns: 60,
      stopReason: "max_turns",
    }
    const [fact] = buildFacts([r])
    expect(fact?.endReason).toBe("max_turns")
    // diagnoseRun -> classify reads endReason; max_turns + empty patch is the
    // no_patch_exhausted bucket. Without the fallback endReason is null and the
    // fact would land in empty_patch_other instead.
  })

  test("#28 single-attempt budget_exhausted / aborted map through", () => {
    const exhausted: InstanceResult = {
      id: "ex",
      passed: false,
      patch: "",
      turns: 1,
      stopReason: "budget_exhausted",
    }
    const aborted: InstanceResult = {
      id: "ab",
      passed: false,
      patch: "",
      turns: 1,
      stopReason: "aborted",
    }
    const facts = buildFacts([exhausted, aborted])
    expect(facts[0]?.endReason).toBe("budget_exhausted")
    expect(facts[1]?.endReason).toBe("timeout")
  })

  test("#28 a clean completion does NOT fabricate an endReason", () => {
    const done: InstanceResult = {
      id: "ok",
      passed: true,
      patch: "diff --git a/x b/x\n",
      turns: 3,
      stopReason: "completed",
    }
    expect(buildFacts([done])[0]?.endReason).toBeNull()
  })

  // ── #29: "0 passed" must not salvage a non-zero exit ──────────────────────
  test("#29 '0 passed' with non-zero exit does NOT grade green", async () => {
    // SIGTERM'd / zero-test run: degenerate "0 passed" summary + non-zero exit,
    // no explicit failure marker. Must stay unresolved.
    const out = await runVerify("printf '0 passed\\n'; exit 143")
    expect(out.passed).toBe(false)
  })

  test("#29 a real '5 passed' summary still salvages a non-zero exit", async () => {
    // The intended salvage path: pytest printed a real pass summary before the
    // wrapper got SIGTERM'd. Positive count ⇒ still PASS.
    const out = await runVerify("printf '5 passed in 0.10s\\n'; exit 143")
    expect(out.passed).toBe(true)
  })

  // ── #30: incidental "N errors" prose must not fail a real PASS ────────────
  test("#30 incidental 'errors' prose in passing output is not failed", async () => {
    const out = await runVerify(
      "printf '1 passed in 0.01s\\nwill raise 2 errors in a future release\\n'; exit 0",
    )
    expect(out.passed).toBe(true)
  })

  test("#30 a real pytest 'N errors' summary line still fails", async () => {
    // Summary-shaped: the count sits after a `, ` segment boundary.
    const out = await runVerify("printf '1 passed, 2 errors in 0.01s\\n'; exit 0")
    expect(out.passed).toBe(false)
  })

  test("#30 a real 'N failed' summary still fails", async () => {
    const out = await runVerify("printf '2 failed, 1 passed in 0.01s\\n'; exit 0")
    expect(out.passed).toBe(false)
  })

  // Unit teeth on the matcher itself (independent of the verdict wiring).
  test("#30 isVerifyOutputFailing: incidental prose vs real summary", () => {
    expect(isVerifyOutputFailing("test_runner", undefined, "this fixes 3 failures cleanly")).toBe(
      false,
    )
    expect(isVerifyOutputFailing("test_runner", undefined, "will raise 2 errors later")).toBe(false)
    // Real summary segments still fire.
    expect(isVerifyOutputFailing("test_runner", undefined, "1 passed, 2 errors in 0.01s")).toBe(
      true,
    )
    expect(isVerifyOutputFailing("test_runner", undefined, "5 examples, 3 failures in 0.5s")).toBe(
      true,
    )
  })
})

// Reverify (100-point) hardening: the #29 fix added a multi-ecosystem
// OUTCOME_SUCCESS_MATCHERS surface + ANSI stripping that the salvage path
// (non-zero exit, no failure marker) trusts. Only the pytest path had teeth;
// these lock every other matcher AND prove the loosest one can't false-green.
const passes = (output: string) => isVerifyOutputPassing("verify", undefined, output)

describe("bugbash #29 — isVerifyOutputPassing matchers (settled-tree hardening)", () => {
  test("go: real `ok <pkg> <duration>` passes; incidental `ok <prose>` does NOT", () => {
    expect(passes("ok  \tgithub.com/foo/bar\t0.012s")).toBe(true)
    expect(passes("ok  github.com/foo/bar (cached)")).toBe(true)
    // Red-on-injection for the tightened `go` matcher: revert it to
    // `/^ok\s+\S+/m` and this line flips to a FALSE GREEN.
    expect(passes("ok we should fix this later")).toBe(false)
  })

  test("each ecosystem matcher: positive passes, near-miss does not", () => {
    expect(passes("OK")).toBe(true) // unittest
    expect(passes("OK (skipped=1)")).toBe(true)
    expect(passes("OK, will do that")).toBe(false)
    expect(passes("Tests:       5 passed, 5 total")).toBe(true) // jest/vitest
    expect(passes("  10 passing")).toBe(true) // mocha
    expect(passes("test result: ok. 3 passed; 0 failed;")).toBe(true) // cargo
    expect(passes("5 examples, 0 failures")).toBe(true) // rspec
    expect(passes("5 examples, 2 failures")).toBe(false)
    expect(passes("OK (5 tests, 12 assertions)")).toBe(true) // phpunit
    expect(passes("Passed!  - Failed:    0, Passed:     5, Skipped:     0")).toBe(true) // dotnet
  })

  test("ANSI-decorated success summary still passes (locks stripAnsiCsi)", () => {
    expect(passes("\x1b[32m===== 5 passed in 0.1s =====\x1b[0m")).toBe(true)
  })

  test("a zero-test / prose-only output never passes", () => {
    expect(passes("0 passed in 0.01s")).toBe(false)
    expect(passes("everything looks ok here")).toBe(false)
    expect(passes("")).toBe(false)
  })
})

describe("bugbash #30 — pytest collection-error banner still recognized as failing", () => {
  const fails = (output: string) => isVerifyOutputFailing("verify", undefined, output)
  test("`===== N errors in ... =====` banner fires generic-error-count", () => {
    // Red-on-injection for the `=\s` boundary: revert generic-error-count to
    // `/(?:^|,\s).../` and this flips to FALSE (a real pytest collection error
    // graded as not-failing on the salvage path).
    expect(fails("==================== 2 errors in 0.53s ====================")).toBe(true)
    expect(fails("=========== 1 error in 0.10s ===========")).toBe(true)
  })
  test("incidental prose with a count is still NOT a failure", () => {
    expect(fails("this change could raise 2 errors later")).toBe(false)
  })
})
