/**
 * HELLGATE — the six test-output parsers must survive malformed input.
 *
 * `parse.ts` opens with the contract: "NEVER-throws — a malformed line is
 * skipped, not fatal." Nothing enforced it, and the implementation contradicted
 * it in ~20 places: every mandatory capture group was read as `m[1]!`, which
 * throws a TypeError rather than skipping the moment the group is absent. Those
 * reads now go through a total accessor, so the contract is achievable — this
 * makes it CHECKED.
 *
 * Why it matters beyond tidiness: these parsers run on whatever a project's test
 * runner printed. Truncation is the normal case, not the exotic one — a killed
 * run, a full pipe buffer, an interleaved stderr write, a runner that changes
 * its format between versions. A throw here does not degrade localization; it
 * fails the whole tool call, and the agent loses the test output entirely.
 *
 * ## Construction
 *
 * Rather than invent malformed text, every real fixture below is DERIVED from
 * output shaped like each runner's own, then damaged in ways a truncated or
 * interleaved stream actually produces: cut mid-line, cut mid-multibyte-marker,
 * had its numbers replaced with non-numeric text, had lone separators left
 * without their blocks. Each parser sees every input — a pytest parser fed cargo
 * output is precisely the "runner detected wrong" case.
 *
 * The assertion is deliberately weak (does not throw, returns a well-formed
 * result) because for garbage input there is no correct parse to demand. What
 * must hold is that the tool call survives and the shape is honest.
 */

import { describe, expect, test } from "bun:test"

import {
  parseCargo,
  parseCtest,
  parseGoJson,
  parseNodeTest,
  parsePytest,
  parsePythonUnittest,
} from "@/tool/testrun/parse"
import type { TestRunResult } from "@/tool/testrun/types"

const PARSERS = [
  ["ctest", parseCtest],
  ["go", parseGoJson],
  ["cargo", parseCargo],
  ["node", parseNodeTest],
  ["pytest", parsePytest],
  ["python-unittest", parsePythonUnittest],
] as const satisfies ReadonlyArray<readonly [string, (s: string) => TestRunResult]>

/** Output in each runner's own shape, from which the damaged variants derive. */
const WELL_FORMED: ReadonlyArray<readonly [string, string]> = [
  [
    "ctest",
    "Assertion failed: (x == 1), function main, file /a/b.c, line 42.\n" +
      "/a/t.cc:7: Failure\nExpected equality of these values:\n[  FAILED  ] Suite.Test (3 ms)\n",
  ],
  [
    "go",
    '{"Action":"fail","Package":"p","Test":"TestA","Output":"x"}\n' +
      '{"Action":"pass","Package":"p","Test":"TestB"}\n',
  ],
  [
    "cargo",
    "failures:\n    tests::a\n\n---- tests::a stdout ----\n" +
      "thread 'tests::a' panicked at src/lib.rs:9:5:\nassertion failed\n  left: 4\n  right: 5\n\n" +
      "test result: FAILED. 1 passed; 1 failed;\n",
  ],
  [
    "node",
    "(fail) my test [1.20ms]\n      at fn (/a/b.test.ts:12:3)\n" +
      "✖ other (4 ms)\nnot ok 3 - tap name\n● Suite › jest\n2 failing\n 1) mocha name\n",
  ],
  [
    "pytest",
    "=================================== FAILURES ===================================\n" +
      "_________________________________ test_a _________________________________\n" +
      "/a/t.py:11: AssertionError\nFAILED t.py::test_a - AssertionError: boom\n1 passed\n",
  ],
  [
    "python-unittest",
    "FAIL: test_a (mod.Class)\n----------------------------------------------------------------------\n" +
      'Traceback (most recent call last):\n  File "/a/t.py", line 8, in test_a\n' +
      "AssertionError: 1 != 2\n======================================================================\n" +
      "Ran 3 tests in 0.1s\n\nFAILED (failures=1)\n",
  ],
]

/** Damage a stream the way a real one gets damaged. */
const DAMAGE: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ["untouched", (s) => s],
  ["truncated-half", (s) => s.slice(0, Math.floor(s.length / 2))],
  ["truncated-to-1-byte", (s) => s.slice(0, 1)],
  // Cuts inside a multibyte marker (✖ / ● / ═) — a pipe closing mid-codepoint.
  ["truncated-odd-byte", (s) => Buffer.from(s, "utf8").subarray(0, 37).toString("utf8")],
  ["no-trailing-newline", (s) => s.trimEnd()],
  ["crlf", (s) => s.replace(/\n/g, "\r\n")],
  // Every digit gone: `Number(m[2])` sees NaN everywhere, and any parser that
  // indexes by a parsed count reads past its array.
  ["digits-stripped", (s) => s.replace(/\d/g, "")],
  // Structural punctuation gone — separators survive without their blocks.
  ["colons-stripped", (s) => s.replace(/:/g, "")],
  ["one-line", (s) => s.replace(/\n/g, " ")],
  ["reversed-lines", (s) => s.split("\n").reverse().join("\n")],
  ["doubled", (s) => s + s],
  ["nul-injected", (s) => s.replace(/\n/, "\0\n")],
]

const DEGENERATE: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["newline-only", "\n"],
  ["whitespace", "   \n\t\n  "],
  ["lone-cargo-separator", "---- "],
  ["lone-pytest-underline", "____"],
  ["lone-unittest-rule", "="],
  ["bare-fail-marker", "(fail) "],
  ["json-fragment", '{"Action":"fai'],
  ["huge-single-line", `x${"y".repeat(50_000)}`],
]

describe("test-output parsers NEVER throw", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ...DEGENERATE,
    ...WELL_FORMED.flatMap(([shape, text]) =>
      DAMAGE.map(([how, f]) => [`${shape}/${how}`, f(text)] as const),
    ),
  ]

  test("anti-vacuity: the battery is populated and reaches every parser", () => {
    expect(cases.length).toBeGreaterThan(70)
    expect(PARSERS.length).toBe(6)
  })

  for (const [name, parse] of PARSERS) {
    test(`${name} survives every damaged input and returns a well-formed result`, () => {
      for (const [label, input] of cases) {
        let result: TestRunResult
        try {
          result = parse(input)
        } catch (err) {
          throw new Error(
            `${name} threw on "${label}" — parse.ts promises NEVER-throws: ${String(err)}`,
          )
        }
        expect(result.runner, label).toBe(name)
        expect(Array.isArray(result.failed), label).toBe(true)
        expect(typeof result.ok, label).toBe("boolean")
        // A count must never be NaN or negative: those flow into the tool's
        // rendered summary, where `NaN passed` is worse than a wrong number
        // because it reads as a broken tool rather than an unparsed runner.
        expect(Number.isInteger(result.passed), `${label} passed=${result.passed}`).toBe(true)
        expect(result.passed, label).toBeGreaterThanOrEqual(0)
        for (const f of result.failed) {
          expect(typeof f.name, label).toBe("string")
          if (f.line !== undefined) {
            expect(Number.isFinite(f.line), `${label} line=${f.line}`).toBe(true)
          }
        }
      }
    })
  }
})
