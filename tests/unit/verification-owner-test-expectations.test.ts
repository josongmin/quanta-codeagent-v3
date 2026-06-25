import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  extractVerificationOwnerTestExpectations,
  ownerTestPathsFromCommands,
} from "@/runner/batch/eval/verification-owner-test-expectations"

const roots: string[] = []

const mkSandbox = (): string => {
  const root = mkdtempSync(join(tmpdir(), "owner-test-expectations-"))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

describe("verification owner test expectations", () => {
  test("ownerTestPathsFromCommands extracts stable python test paths from bench commands", () => {
    expect(
      ownerTestPathsFromCommands([
        "python -m pytest -x tests/test_widget.py",
        "uv run pytest 'tests/test_widget.py::test_exact_message'",
        "python -m pytest src/widget.py",
      ]),
    ).toEqual(["tests/test_widget.py"])
  })

  test("extractVerificationOwnerTestExpectations reads public assert/message literals from existing tests", async () => {
    const sandbox = mkSandbox()
    const testPath = join(sandbox, "tests")
    mkdirSync(testPath, { recursive: true })
    writeFileSync(
      join(testPath, "test_widget.py"),
      [
        "def test_exact_message():",
        '    assert str(exc.value) == "widget must stay immutable"',
        "",
        "def test_regex():",
        '    with pytest.raises(ValueError, match="expected widget id"):',
        "        pass",
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest tests/test_widget.py"],
    })

    expect(facts).toEqual([
      "tests/test_widget.py::test_exact_message exact/public literal: widget must stay immutable",
      "tests/test_widget.py::test_regex exact/public literal: expected widget id",
    ])
  })

  test("T2 fallback: REAL astropy-13033 shape — non-convention test filename (test_sampled.py) found by glob + MULTI-LINE match=() literal extracted", async () => {
    // 13033 reality: owner is astropy/timeseries/core.py, but astropy does NOT use
    // test_core.py — the message lives in tests/test_sampled.py, and the assertion
    // spans multiple lines as `match=( r"..." )`. The pure `test_<module>.py`
    // convention misses the file AND single-line mining misses the literal; the
    // glob + logical-line join must recover it.
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "astropy/timeseries/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_sampled.py"),
      [
        "def test_required_columns_message():",
        "    with pytest.raises(",
        "        ValueError,",
        '        match=(r"TimeSeries object is invalid - expected "',
        '              r"as the first column but found something else"),',
        "    ):",
        "        TimeSeries()",
      ].join("\n"),
    )

    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: [], // no command-derived path ⇒ fallback triggers
      localizedOwnerFiles: ["astropy/timeseries/core.py"],
    })

    expect(facts.length).toBeGreaterThan(0)
    expect(facts.join(" ")).toContain("test_sampled.py")
    expect(facts.join(" ")).toContain(
      "TimeSeries object is invalid - expected as the first column but found something else",
    )
    expect(facts.join(" ")).toContain("as the first column but found something else")
    expect(facts.join(" ")).not.toContain("TimeSeries object is invalid - expected |")
  })

  test("TEETH: an expectation with ZERO issue-symbol overlap is STILL surfaced (unranked, source order) within the size budget", async () => {
    // The fix removed the issue-symbol keyword-overlap re-rank+small-cap that withheld
    // test contracts whose wording did not lexically match the issue symbols. Here the
    // FIRST assert shares NO token with the issue symbol ("TimeSeries") yet must reach
    // the model. Under the OLD score-sort + maxExpectations=2 cap, the two lexically
    // matching asserts would outrank and DROP the zero-overlap assert.
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "astropy/timeseries/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_sampled.py"),
      [
        "def test_zero_overlap_contract():",
        // No token here overlaps the "TimeSeries" issue symbol.
        '    assert str(exc.value) == "rows must be sorted ascending"',
        "def test_match_a():",
        '    assert str(exc.value) == "TimeSeries object is invalid - first"',
        "def test_match_b():",
        '    assert str(exc.value) == "TimeSeries object is invalid - second"',
      ].join("\n"),
    )

    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: [],
      localizedOwnerFiles: ["astropy/timeseries/core.py"],
      issueSymbols: ["TimeSeries"],
    })

    // The zero-overlap contract is surfaced (it is first in source order, well within
    // the budget) — NOT dropped in favor of the lexically matching asserts.
    expect(facts).toContain(
      "astropy/timeseries/tests/test_sampled.py::test_zero_overlap_contract exact/public literal: rows must be sorted ascending",
    )
    // All three contracts fit the budget; none is withheld by a relevance guess.
    expect(facts.join(" ")).toContain("TimeSeries object is invalid - first")
    expect(facts.join(" ")).toContain("TimeSeries object is invalid - second")
  })

  test("UNRANKED ORDER: expectations are surfaced in stable SOURCE order, not issue-symbol order", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_invalid_message_noise():",
        '    assert str(exc.value) == "invalid widget state"',
        "def test_id_message_signal():",
        '    assert str(exc.value) == "id must be positive"',
      ].join("\n"),
    )

    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
      issueSymbols: ["id"],
    })

    // Source order preserved — the "id"-matching assert is NOT hoisted to the front.
    expect(facts).toEqual([
      "pkg/tests/test_widget.py::test_invalid_message_noise exact/public literal: invalid widget state",
      "pkg/tests/test_widget.py::test_id_message_signal exact/public literal: id must be positive",
    ])
  })

  test("T2: a STALE message in a comment / docstring is NOT mined as an exact literal (no wrong-steer)", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_msg():",
        '    """historical: the message used to be "OLD WRONG MESSAGE"."""',
        '    # legacy assert was: assert str(e) == "ANOTHER STALE ONE"',
        '    assert str(e) == "the correct current message"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    expect(facts.join(" ")).toContain("the correct current message")
    expect(facts.join(" ")).not.toContain("OLD WRONG MESSAGE")
    expect(facts.join(" ")).not.toContain("ANOTHER STALE ONE")
  })

  test("ROUND-5 regression: a stale message in an INLINE trailing comment is NOT mined; a `#` inside a real literal survives", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_inline():",
        '    assert str(e) == "the real message"  # was "STALE INLINE MESSAGE"',
        "def test_hash_literal():",
        '    assert color == "uses color #fff hex here"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    expect(facts.join(" ")).toContain("the real message")
    expect(facts.join(" ")).not.toContain("STALE INLINE MESSAGE")
    // A '#' inside a genuine quoted literal must be preserved (not treated as a comment).
    expect(facts.join(" ")).toContain("uses color #fff hex here")
  })

  test("T2 fallback is OFF without localizedOwnerFiles ⇒ byte-identical command-only behavior (no false discovery)", async () => {
    const sandbox = mkSandbox()
    // A convention test exists, but with NO localizedOwnerFiles the fallback must
    // NOT run (command-only, byte-identical to pre-T2).
    const testDir = join(sandbox, "astropy/timeseries/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_core.py"),
      'def test_x():\n    assert str(e) == "must not be discovered"',
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: [],
    })
    expect(facts).toEqual([])
  })

  test("M1 regression: a multi-line triple-quoted VALUE does not swallow a following test's real message", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_repr():",
        "    expected = textwrap.dedent('''",
        "        some multiline",
        "        value here",
        "    ''')",
        "    assert repr(obj) == expected",
        "def test_message():",
        '    with pytest.raises(ValueError, match="the real error message"):',
        "        do_thing()",
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    // The close-only `''')` must NOT re-arm docstring mode and swallow test_message.
    expect(facts.join(" ")).toContain("the real error message")
  })

  test("DOCUMENTED LIMITATION: triple-quoted message VALUES are NOT mined (rare shape; stripped to kill the docstring false-steer class) while adjacent SINGLE-quoted strings ARE", async () => {
    // Settled design after the audit loop: all triple-quoted spans are dropped (a
    // false expectation from a docstring is worse than a missed rare value). The
    // REAL astropy-13033 shape uses adjacent r"..." SINGLE-quoted strings, which are
    // mined; a triple-quoted assertion message is a documented recall gap.
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_triple():",
        '    assert str(exc.value) == """a triple quoted message here"""',
        "def test_adjacent():",
        "    with pytest.raises(",
        '        ValueError, match=(r"the real expected "',
        '                           r"adjacent-string message")):',
        "        do()",
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    // The adjacent single-quoted (r"...") message — the real 13033 shape — is mined.
    expect(facts.join(" ")).toContain("the real expected adjacent-string message")
    // The triple-quoted value is the accepted recall gap (no false steer either).
    expect(facts.join(" ")).not.toContain("a triple quoted message here")
  })

  test("MAJOR-1 regression: a BARE single-line docstring whose prose contains 'assert'/'match=' is NOT mined; the real message survives the cap", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_immutable():",
        // Docstring at order 0 with assertion-ish prose — must NOT become a fact,
        // and must NOT evict the real message under PER_FILE_EXPECTATION_CAP.
        '    """We assert the widget stays immutable; pytest.raises match= here."""',
        '    with pytest.raises(ValueError, match="the real expected message"):',
        "        rebind(widget)",
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    expect(facts.join(" ")).toContain("the real expected message")
    expect(facts.join(" ")).not.toContain("widget stays immutable")
  })

  test("T2 triple scanner ignores triple tokens inside ordinary strings before stripping docstrings", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_msg():",
        '    pattern = \'literal triple token: """\'',
        '    """assert str(e) == "STALE DOCSTRING MESSAGE" """',
        '    assert str(e) == "REAL MESSAGE AFTER STRING TOKEN"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    expect(facts.join(" ")).toContain("REAL MESSAGE AFTER STRING TOKEN")
    expect(facts.join(" ")).not.toContain("STALE DOCSTRING MESSAGE")
  })

  test("T2 unterminated triple span drops fake asserts after the open span", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_msg():",
        '    assert str(e) == "REAL BEFORE UNTERMINATED"',
        '    detail = """this string never closes',
        '    assert str(e) == "FAKE INSIDE UNTERMINATED"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    expect(facts.join(" ")).toContain("REAL BEFORE UNTERMINATED")
    expect(facts.join(" ")).not.toContain("FAKE INSIDE UNTERMINATED")
  })

  test("T2 single public test file can use the total expectation cap, not the two-fact diversity cap", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_a():",
        '    assert str(e) == "FIRST REAL MESSAGE"',
        "def test_b():",
        '    assert str(e) == "SECOND REAL MESSAGE"',
        "def test_c():",
        '    assert str(e) == "THIRD REAL MESSAGE"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
      maxExpectations: 4,
    })
    expect(facts.join(" ")).toContain("FIRST REAL MESSAGE")
    expect(facts.join(" ")).toContain("SECOND REAL MESSAGE")
    expect(facts.join(" ")).toContain("THIRD REAL MESSAGE")
  })

  test("M2 regression: an in-string bracket does NOT over-join the next test (no cross-test literal mis-attribution)", async () => {
    const sandbox = mkSandbox()
    const testDir = join(sandbox, "pkg/tests")
    mkdirSync(testDir, { recursive: true })
    writeFileSync(
      join(testDir, "test_widget.py"),
      [
        "def test_a():",
        '    assert msg == "unterminated paren foo("',
        "def test_b():",
        '    assert other == "TOTALLY UNRELATED MESSAGE"',
      ].join("\n"),
    )
    const facts = await extractVerificationOwnerTestExpectations({
      sandbox,
      ownerNearTests: ["python -m pytest pkg/tests/test_widget.py"],
    })
    // test_a's fact must NOT carry test_b's message (the over-join bug).
    const aFact = facts.find((f) => f.includes("::test_a"))
    expect(aFact ?? "").not.toContain("TOTALLY UNRELATED MESSAGE")
  })
})
