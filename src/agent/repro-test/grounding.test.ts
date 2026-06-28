import { describe, expect, test } from "bun:test"
import {
  EXEMPLAR_BLOCK_HEADER,
  exemplarBlock,
  SIGNATURE_BLOCK_HEADER,
  signatureBlock,
  stripTestBodies,
} from "./grounding"

// A realistic sphinx-style test file: the fixture pattern we WANT to keep
// (import path, @pytest.mark.sphinx marker, `app` fixture param) wrapped around
// assertions that embed a SECRET expected value we must NOT leak.
const SPHINX_TEST = `import pytest
from sphinx.testing.util import SphinxTestApp

pytestmark = pytest.mark.sphinx_secret_marker

EXPECTED_SECRET = "the-gold-answer-42"


@pytest.mark.sphinx("html", testroot="ext-autodoc")
def test_autodoc_preserves_tuple_default(app: SphinxTestApp, tmp_path):
    app.build()
    content = (app.outdir / "index.html").read_text()
    assert "the-gold-answer-42" in content
    assert content.count("def foo") == 7


class TestNested:
    @pytest.fixture
    def widget(self):
        return make_widget(secret_value="leak-me-too")

    def test_widget_roundtrip(self, widget):
        assert widget.value == "leak-me-too"
`

describe("stripTestBodies — NO-LEAK fence (red-on-injection)", () => {
  const stripped = stripTestBodies(SPHINX_TEST)

  test("elides assertion bodies — gold/secret values do NOT survive", () => {
    // The load-bearing invariant. If the strip ever keeps a body line, these fail.
    expect(stripped).not.toContain("the-gold-answer-42")
    expect(stripped).not.toContain("leak-me-too")
    expect(stripped).not.toContain("EXPECTED_SECRET")
    expect(stripped).not.toMatch(/\bassert\b/)
    expect(stripped).not.toContain("app.build()")
    expect(stripped).not.toContain(".count(")
  })

  test("KEEPS the fixture pattern — import paths, markers, signatures (literals redacted)", () => {
    expect(stripped).toContain("from sphinx.testing.util import SphinxTestApp")
    // marker SHAPE kept, literal args redacted (C6 no-leak hardening).
    expect(stripped).toContain('@pytest.mark.sphinx("", testroot="")')
    // fixture param shape is the whole point — `app`/`tmp_path` must remain.
    expect(stripped).toContain(
      "def test_autodoc_preserves_tuple_default(app: SphinxTestApp, tmp_path):",
    )
    expect(stripped).toContain("@pytest.fixture")
    expect(stripped).toContain("class TestNested:")
  })

  test("each kept signature is followed by an elision placeholder", () => {
    expect(stripped).toContain("...  # body elided (no-leak)")
    // every `def`/`class` line is paired with a placeholder ⇒ #placeholders >= #defs
    const defs = (stripped.match(/^\s*(?:async\s+)?(?:def|class)\b/gm) ?? []).length
    const elisions = (stripped.match(/\.\.\. {2}# body elided/g) ?? []).length
    expect(elisions).toBeGreaterThanOrEqual(defs)
  })

  test("module-level non-structural statements (constants) are dropped", () => {
    // `EXPECTED_SECRET = ...` and `pytestmark = ...` are module-level assignments
    // that could carry expected values ⇒ dropped.
    expect(stripped).not.toContain("EXPECTED_SECRET =")
    expect(stripped).not.toContain("pytestmark =")
  })

  test("multi-line signatures are kept whole", () => {
    const multi = `def test_big(
    app,
    tmp_path,
    monkeypatch,
):
    assert secret == 1
`
    const s = stripTestBodies(multi)
    expect(s).toContain("def test_big(")
    expect(s).toContain("monkeypatch,")
    expect(s).not.toMatch(/\bassert\b/)
    expect(s).not.toContain("secret")
  })

  test("idempotent — stripping a skeleton again is a no-op on bodies", () => {
    expect(stripTestBodies(stripped)).toBe(stripTestBodies(stripTestBodies(SPHINX_TEST)))
    // and re-strip still leaks nothing
    expect(stripTestBodies(stripped)).not.toMatch(/\bassert\b/)
  })

  test("empty / whitespace ⇒ empty string", () => {
    expect(stripTestBodies("")).toBe("")
    expect(stripTestBodies("   \n\t\n")).toBe("")
    // @ts-expect-error — defensive against non-string at the JS boundary
    expect(stripTestBodies(undefined)).toBe("")
  })

  // ── C6 adversarial no-leak cases (regressions found by the hell-audit) ──

  test("BLOCKER: single-line `def f(): assert == GOLD` body is CUT at the colon", () => {
    const s = stripTestBodies('def test_x(): assert foo == "GOLD-INLINE"\n')
    expect(s).not.toContain("GOLD-INLINE")
    expect(s).not.toMatch(/\bassert\b/)
    expect(s).toContain("def test_x():")
  })

  test("BLOCKER: single-line body does NOT swallow trailing module constants", () => {
    const s = stripTestBodies(
      [
        'def test_x(): assert foo == "GOLD"',
        'SECRET_TABLE = {1: "g1", 2: "g2"}',
        "def helper():",
      ].join("\n"),
    )
    expect(s).not.toContain("GOLD")
    expect(s).not.toContain("g1")
    expect(s).not.toContain("SECRET_TABLE")
    expect(s).toContain("def test_x():")
    expect(s).toContain("def helper():")
  })

  test("HIGH: single-line @parametrize value table is redacted", () => {
    const s = stripTestBodies(
      [
        '@pytest.mark.parametrize("x,expected", [(1, "GOLD"), (2, "SECRET")])',
        "def test_p(x, expected):",
        "    assert f(x) == expected",
      ].join("\n"),
    )
    expect(s).not.toContain("GOLD")
    expect(s).not.toContain("SECRET")
    // marker shape survives so the model still learns the fixture
    expect(s).toContain("@pytest.mark.parametrize")
    expect(s).toContain("def test_p(x, expected):")
  })

  test("HIGH: numeric expected values in tables/decorators are redacted to 0", () => {
    const s = stripTestBodies(
      ['@pytest.mark.parametrize("n,out", [(3, 42)])', "def test_n(n, out):"].join("\n"),
    )
    expect(s).not.toContain("42")
  })

  test("MED: nested def default-arg constant is redacted", () => {
    const s = stripTestBodies(
      ["def outer():", '    def inner(default="LEAK-VIA-DEFAULT"):', "        return default"].join(
        "\n",
      ),
    )
    expect(s).not.toContain("LEAK-VIA-DEFAULT")
    expect(s).toContain("def inner(default=")
  })

  test("mock.patch return_value constant is redacted", () => {
    const s = stripTestBodies(
      ['@mock.patch("mod.fn", return_value="EXPECTED-GOLD")', "def test_m():"].join("\n"),
    )
    expect(s).not.toContain("EXPECTED-GOLD")
    expect(s).toContain("@mock.patch")
  })

  test("per-skeleton char cap head-truncates a huge class", () => {
    const huge = [
      "class Big:",
      ...Array.from({ length: 4000 }, (_, i) => `    def m${i}(self): ...`),
    ].join("\n")
    const s = stripTestBodies(huge)
    expect(s.length).toBeLessThan(6200)
    expect(s).toContain("skeleton truncated")
  })
})

describe("exemplarBlock", () => {
  test("undefined / empty ⇒ [] (byte-identical to un-grounded prompt)", () => {
    expect(exemplarBlock(undefined)).toEqual([])
    expect(exemplarBlock([])).toEqual([])
    expect(exemplarBlock(["", "   "])).toEqual([])
  })

  test("defensively re-strips bodies — a caller that forgets cannot leak", () => {
    // Pass a RAW (un-stripped) test file with a secret assertion.
    const block = exemplarBlock([SPHINX_TEST]).join("\n")
    expect(block).toContain(EXEMPLAR_BLOCK_HEADER)
    expect(block).toContain("from sphinx.testing.util import SphinxTestApp")
    expect(block).not.toContain("the-gold-answer-42")
    expect(block).not.toMatch(/\bassert\b/)
  })

  test("fence-wraps each skeleton", () => {
    const block = exemplarBlock(["import os\ndef test_x():\n    assert os"])
    const joined = block.join("\n")
    expect((joined.match(/```python/g) ?? []).length).toBe(1)
    expect(joined).toContain("import os")
  })
})

describe("signatureBlock", () => {
  test("undefined / empty ⇒ []", () => {
    expect(signatureBlock(undefined)).toEqual([])
    expect(signatureBlock([])).toEqual([])
    expect(signatureBlock(["  ", ""])).toEqual([])
  })

  test("emits the signatures under a header inside a fence", () => {
    const block = signatureBlock([
      "def stringify(obj: object) -> str: ...",
      "class Widget: ...",
    ]).join("\n")
    expect(block).toContain(SIGNATURE_BLOCK_HEADER)
    expect(block).toContain("def stringify(obj: object) -> str: ...")
    expect(block).toContain("class Widget: ...")
    expect((block.match(/```python/g) ?? []).length).toBe(1)
  })
})
