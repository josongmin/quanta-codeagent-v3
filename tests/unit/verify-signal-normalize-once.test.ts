/**
 * FIX A characterization — `isVerifyOutputPassing` must classify identically
 * whether or not it re-normalizes the text before delegating to
 * `isVerifyOutputFailing`.
 *
 * Before the fix, `isVerifyOutputPassing` normalized the output (stripping ANSI
 * CSI) and then passed the ALREADY-normalized string back into
 * `isVerifyOutputFailing`, which normalized a SECOND time — a redundant
 * `stripAnsiCsi` pass on the hot verify-output path. `stripAnsiCsi` is
 * idempotent, so the pass/fail RESULT was already correct; this test locks that
 * RESULT so the single-normalize refactor cannot drift it.
 *
 * Coverage targets the inputs where a double-pass could conceivably matter:
 *   - ANSI-laden output (the only text `stripAnsiCsi` actually rewrites)
 *   - multi-pattern output (a success summary AND a failure summary present —
 *     failure must win, the `isVerifyOutputFailing` short-circuit)
 *   - ANSI wrapped around the marker tokens themselves (a non-idempotent strip
 *     would corrupt the marker and flip the verdict)
 */
import { describe, expect, test } from "bun:test"
import { isVerifyOutputFailing, isVerifyOutputPassing } from "@/agent/verify-signal"

const ESC = String.fromCharCode(0x1b)
const passing = (out: string): boolean => isVerifyOutputPassing("test_runner", undefined, out)
const failing = (out: string): boolean => isVerifyOutputFailing("test_runner", undefined, out)

describe("FIX A — isVerifyOutputPassing single-normalize classification identity", () => {
  // Each row pins the EXACT (passing, failing) verdict for an input. Locked
  // against the current (double-normalize) code so the refactor proves identity.
  const cases: ReadonlyArray<{ name: string; output: string; pass: boolean; fail: boolean }> = [
    {
      name: "ANSI-coloured pytest pass summary ⇒ passing",
      output: `${ESC}[32m===== 5 passed in 0.42s =====${ESC}[0m`,
      pass: true,
      fail: false,
    },
    {
      name: "ANSI-coloured pytest fail summary ⇒ failing, not passing",
      output: `${ESC}[31m===== 3 failed in 0.42s =====${ESC}[0m`,
      pass: false,
      fail: true,
    },
    {
      name: "ANSI wraps the marker token characters themselves ⇒ still passing",
      // colour codes interleaved AROUND the summary line; a non-idempotent or
      // mis-ordered strip would corrupt `passed` and lose the GREEN signal.
      output: `${ESC}[1m${ESC}[32mok${ESC}[0m  github.com/foo/bar/pkg 0.012s`,
      pass: true,
      fail: false,
    },
    {
      name: "multi-pattern: pass AND fail summaries present ⇒ fail wins (not passing)",
      output: ["===== 2 passed in 0.10s =====", "===== 1 failed in 0.20s ====="].join("\n"),
      pass: false,
      fail: true,
    },
    {
      name: "ANSI multi-pattern: coloured pass + coloured fail ⇒ fail wins",
      output: [
        `${ESC}[32m5 passed in 0.42s${ESC}[0m`,
        `${ESC}[31mFAILED tests/test_x.py::test_y${ESC}[0m`,
      ].join("\n"),
      pass: false,
      fail: true,
    },
    {
      name: "plain pass summary, no ANSI ⇒ passing",
      output: "5 examples, 0 failures",
      pass: true,
      fail: false,
    },
    {
      name: "neither marker present ⇒ neither passing nor failing",
      output: `${ESC}[33msome incidental log line${ESC}[0m`,
      pass: false,
      fail: false,
    },
    {
      name: "empty ⇒ neither",
      output: "",
      pass: false,
      fail: false,
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(passing(c.output)).toBe(c.pass)
      expect(failing(c.output)).toBe(c.fail)
    })
  }

  test("passing implies no failure marker (mirror invariant holds under ANSI)", () => {
    // For ANY of the cases, a `passing===true` verdict must coincide with
    // `failing===false` — the short-circuit `isVerifyOutputPassing` relies on.
    for (const c of cases) {
      if (passing(c.output)) expect(failing(c.output)).toBe(false)
    }
  })
})
