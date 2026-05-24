/**
 * Repro-test selection — unit contract.
 *
 *   - stripPythonComments: removes `#` to EOL; respects string literals;
 *     respects triple-quoted strings (no comment lookup inside).
 *   - normaliseReproSource: order = docstrings → comments → fn-name →
 *     whitespace; produces stable group keys.
 *   - selectReproTest:
 *       - filters non-"reproduced" samples
 *       - returns null when zero reproduced
 *       - majority-vote selects most-frequent normalised key
 *       - tiebreak: first-appearance wins
 *       - returns ORIGINAL source (not normalised) of the winner
 */
import { describe, expect, test } from "bun:test"
import {
  normaliseReproSource,
  selectReproTest,
  stripPythonComments,
} from "../../../src/agent/repro-test/select"
import type { ReproTestSample } from "../../../src/agent/repro-test/types"

const mkSample = (
  source: string,
  outcome: ReproTestSample["outcome"] = "reproduced",
): ReproTestSample => ({ source, stdout: "", outcome })

describe("stripPythonComments", () => {
  test("strips `#` to end-of-line", () => {
    const src = "x = 1  # foo\ny = 2"
    expect(stripPythonComments(src)).toBe("x = 1  \ny = 2")
  })

  test("preserves `#` inside double-quoted strings", () => {
    const src = 'msg = "# not a comment"'
    expect(stripPythonComments(src)).toBe(src)
  })

  test("preserves `#` inside single-quoted strings", () => {
    const src = "msg = '# not a comment'"
    expect(stripPythonComments(src)).toBe(src)
  })

  test("preserves `#` inside triple-quoted strings", () => {
    const src = 'doc = """\n# still data\n# also data\n"""'
    expect(stripPythonComments(src)).toBe(src)
  })

  test("strips comment after string close", () => {
    const src = 'x = "a"  # this is a comment'
    expect(stripPythonComments(src)).toBe('x = "a"  ')
  })

  test("backslash escapes in single-quote string", () => {
    const src = "x = 'a\\'b'  # comment"
    const got = stripPythonComments(src)
    expect(got).toContain("'a\\'b'")
    expect(got).not.toContain("# comment")
  })

  test("empty string", () => {
    expect(stripPythonComments("")).toBe("")
  })
})

describe("normaliseReproSource", () => {
  test("test_ function names normalise to test_repro", () => {
    const a = "def test_unicode_error_42():\n    pass"
    const b = "def test_repro():\n    pass"
    expect(normaliseReproSource(a)).toBe(normaliseReproSource(b))
  })

  test("comments don't affect the key", () => {
    const a = "import x  # comment A\nprint('Issue reproduced')"
    const b = "import x  # comment B\nprint('Issue reproduced')"
    expect(normaliseReproSource(a)).toBe(normaliseReproSource(b))
  })

  test("docstrings don't affect the key", () => {
    const a = '"""docstring A"""\nimport x'
    const b = '"""docstring B"""\nimport x'
    expect(normaliseReproSource(a)).toBe(normaliseReproSource(b))
  })

  test("whitespace runs collapse but lines preserved", () => {
    const a = "x   =   1\ny = 2"
    const b = "x = 1\ny = 2"
    expect(normaliseReproSource(a)).toBe(normaliseReproSource(b))
  })

  test("multiple blank lines collapse to one", () => {
    const a = "import x\n\n\n\nimport y"
    const b = "import x\n\nimport y"
    expect(normaliseReproSource(a)).toBe(normaliseReproSource(b))
  })

  test("empty / non-string ⇒ ''", () => {
    expect(normaliseReproSource("")).toBe("")
    expect(normaliseReproSource(undefined as unknown as string)).toBe("")
  })

  test("non-test function names are preserved", () => {
    const a = "def helper_42():\n    pass"
    const b = "def helper_43():\n    pass"
    expect(normaliseReproSource(a)).not.toBe(normaliseReproSource(b))
  })
})

describe("selectReproTest", () => {
  test("returns null when no sample reproduced", () => {
    const sel = selectReproTest([
      mkSample("a", "other"),
      mkSample("b", "exec_failed"),
      mkSample("c", "unknown"),
    ])
    expect(sel.selected).toBeNull()
    expect(sel.reproducedCount).toBe(0)
    expect(sel.samples).toHaveLength(3)
  })

  test("returns null on empty input", () => {
    const sel = selectReproTest([])
    expect(sel.selected).toBeNull()
    expect(sel.reproducedCount).toBe(0)
  })

  test("single reproduced sample wins trivially", () => {
    const src = 'print("Issue reproduced")'
    const sel = selectReproTest([mkSample(src), mkSample("other", "other")])
    expect(sel.selected).toBe(src)
    expect(sel.reproducedCount).toBe(1)
  })

  test("majority vote: 3 identical reproductions beat 1 different", () => {
    const a = 'import x\nprint("Issue reproduced")'
    const b = 'import y\nprint("Issue reproduced")'
    const sel = selectReproTest([mkSample(a), mkSample(a), mkSample(a), mkSample(b)])
    expect(sel.selected).toBe(a)
    expect(sel.reproducedCount).toBe(4)
  })

  test("majority vote tolerates comment / fn-name variants (normalisation)", () => {
    const v1 = "def test_xxx():\n    print('Issue reproduced')  # variant 1"
    const v2 = "def test_yyy():\n    print('Issue reproduced')  # variant 2"
    const v3 = "def test_zzz():\n    print('Issue reproduced')  # variant 3"
    const different = "import sys\nprint('Issue reproduced')"
    // v1/v2/v3 normalise to the same key (3 votes); `different` is alone.
    const sel = selectReproTest([mkSample(v1), mkSample(v2), mkSample(v3), mkSample(different)])
    // Winner is v1 (first appearance among the majority group).
    expect(sel.selected).toBe(v1)
    expect(sel.reproducedCount).toBe(4)
  })

  test("tiebreak: first-appearance wins", () => {
    const a = "import a\nprint('Issue reproduced')"
    const b = "import b\nprint('Issue reproduced')"
    // 2 votes for a, 2 votes for b ⇒ a wins (appeared first).
    const sel = selectReproTest([mkSample(a), mkSample(b), mkSample(a), mkSample(b)])
    expect(sel.selected).toBe(a)
  })

  test("returns ORIGINAL (un-normalised) source of the winner", () => {
    // The winning source has comments + fn-name decoration; the
    // normalisation collapses them, but the agent receives the ORIGINAL.
    const winning = "# original comment\ndef test_my_bug():\n    print('Issue reproduced')"
    const loser = "print('Issue reproduced')"
    const sel = selectReproTest([mkSample(winning), mkSample(winning), mkSample(loser)])
    expect(sel.selected).toBe(winning)
  })

  test("non-reproduced samples ignored in vote even if frequent", () => {
    const goodMinority = 'print("Issue reproduced")'
    const otherMajority = 'print("Other issues")'
    const sel = selectReproTest([
      mkSample(otherMajority, "other"),
      mkSample(otherMajority, "other"),
      mkSample(otherMajority, "other"),
      mkSample(goodMinority),
    ])
    expect(sel.selected).toBe(goodMinority)
    expect(sel.reproducedCount).toBe(1)
  })

  test("samples array passed through verbatim for observability", () => {
    const samples = [mkSample("a"), mkSample("b", "other")]
    const sel = selectReproTest(samples)
    expect(sel.samples).toBe(samples)
  })
})
