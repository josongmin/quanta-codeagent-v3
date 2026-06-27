/**
 * jun-28 repair assertion-pin (audit #2). The repair failure tail is byte-truncated;
 * for a long pytest run the naive last-N-chars captures trailing warnings/summary
 * and CUTS the `E   assert …` longrepr the agent must satisfy. `pinPytestAssertion`
 * pins the FAILURES region at the front so the assertion survives truncation.
 *
 * TEETH: the byte-tail LOSES the assertion; the pinned tail KEEPS it. A non-pytest
 * blob is a strict no-op (byte-identical byte-tail).
 */
import { describe, expect, test } from "bun:test"
import { pinPytestAssertion } from "../../src/runner/batch/eval/repair/pytest-assertion-pin"

// A realistic pytest failure: the assertion is HIGH in the output, followed by a
// long trailing wall of warnings that a byte-tail would keep instead.
const ASSERTION = [
  "=================================== FAILURES ===================================",
  "____________________________ test_migration_state _____________________________",
  "    def test_migration_state():",
  ">       assert loader.build_graph().nodes == expected",
  "E       AssertionError: assert {'a': 1} == {'a': 1, 'b': 2}",
  "E         Right contains 1 more item: {'b': 2}",
  "migrations/test_loader.py:512: AssertionError",
].join("\n")
const TRAILING_NOISE = `${"\n".padEnd(1, "\n")}${Array.from({ length: 200 }, (_, i) => `  warnings summary ${i}: DeprecationWarning blah blah blah blah blah`).join("\n")}`
const SUMMARY = "FAILED migrations/test_loader.py::test_migration_state - AssertionError: assert {'a': 1} == {'a': 1, 'b': 2}"
const PYTEST_OUTPUT = `${ASSERTION}\n=========================== short test summary info ============================\n${SUMMARY}${TRAILING_NOISE}`

describe("pinPytestAssertion", () => {
  test("byte-tail LOSES the assertion; pinned tail KEEPS it (the bug-catcher)", () => {
    const cap = 1500
    // Baseline: naive byte-tail drops the FAILURES block (it is far above the cap).
    const byteTail = PYTEST_OUTPUT.slice(-cap)
    expect(byteTail.includes("E       AssertionError: assert {'a': 1}")).toBe(false)

    // Pinned: the assertion detail is present at the front.
    const pinned = pinPytestAssertion(PYTEST_OUTPUT, cap)
    expect(pinned.includes("E       AssertionError: assert {'a': 1} == {'a': 1, 'b': 2}")).toBe(true)
    expect(pinned.includes("Right contains 1 more item")).toBe(true)
    expect(pinned.length).toBeLessThanOrEqual(cap)
  })

  test("includes the FAILED summary one-liner (concise expected/actual)", () => {
    const pinned = pinPytestAssertion(PYTEST_OUTPUT, 1500)
    expect(pinned.includes("FAILED migrations/test_loader.py::test_migration_state")).toBe(true)
  })

  test("short output (≤ cap) is returned verbatim", () => {
    expect(pinPytestAssertion(ASSERTION, 10_000)).toBe(ASSERTION)
  })

  test("non-pytest blob ⇒ strict no-op (identical to the byte-tail)", () => {
    const blob = Array.from({ length: 500 }, (_, i) => `log line ${i} some output here`).join("\n")
    const cap = 800
    expect(pinPytestAssertion(blob, cap)).toBe(blob.slice(-cap))
  })

  test("loose `E ` assertion lines (no FAILURES banner, -q mode) are still pinned", () => {
    const q = `${Array.from({ length: 100 }, (_, i) => `noise ${i} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`).join("\n")}\nE   assert 2 == 3\n${Array.from({ length: 100 }, (_, i) => `tail ${i} bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`).join("\n")}`
    const pinned = pinPytestAssertion(q, 600)
    expect(pinned.includes("E   assert 2 == 3")).toBe(true)
  })
})
