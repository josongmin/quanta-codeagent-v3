import { describe, expect, test } from "bun:test"
import { buildReproTestPrompt } from "./generate"
import { EXEMPLAR_BLOCK_HEADER, SIGNATURE_BLOCK_HEADER } from "./grounding"

const ISSUE = "Foo.bar() returns None for empty input but should raise ValueError."

const EXISTING_TEST = `import pytest
from pkg.testing import AppHarness

@pytest.mark.harness("html")
def test_existing(app: AppHarness):
    app.build()
    assert app.result == "gold-secret-value"
`

describe("buildReproTestPrompt — grounding injection (C2)", () => {
  const baseline = buildReproTestPrompt(ISSUE)

  test("undefined grounding ⇒ BYTE-IDENTICAL to un-grounded (default-OFF invariant)", () => {
    expect(buildReproTestPrompt(ISSUE, undefined, "canonical", undefined)).toBe(baseline)
  })

  test("empty grounding arrays ⇒ byte-identical (no dangling blocks)", () => {
    expect(
      buildReproTestPrompt(ISSUE, undefined, "canonical", {
        exemplarSkeletons: [],
        issueSignatures: [],
      }),
    ).toBe(baseline)
    expect(
      buildReproTestPrompt(ISSUE, undefined, "canonical", {
        exemplarSkeletons: ["", "  "],
        issueSignatures: ["   "],
      }),
    ).toBe(baseline)
  })

  test("exemplar skeletons are spliced — and bodies do NOT leak through the prompt", () => {
    const prompt = buildReproTestPrompt(ISSUE, undefined, "canonical", {
      exemplarSkeletons: [EXISTING_TEST],
    })
    expect(prompt.length).toBeGreaterThan(baseline.length)
    expect(prompt).toContain(EXEMPLAR_BLOCK_HEADER)
    expect(prompt).toContain("from pkg.testing import AppHarness")
    expect(prompt).toContain("@pytest.mark.harness") // marker kept, literal redacted
    // NO-LEAK end-to-end: the secret assertion value must not reach the prompt.
    expect(prompt).not.toContain("gold-secret-value")
    expect(prompt).not.toContain("app.build()")
  })

  test("issue signatures are spliced", () => {
    const prompt = buildReproTestPrompt(ISSUE, undefined, "canonical", {
      issueSignatures: ["def bar(self) -> int | None: ..."],
    })
    expect(prompt).toContain(SIGNATURE_BLOCK_HEADER)
    expect(prompt).toContain("def bar(self) -> int | None: ...")
  })

  test("grounding composes with the MWE block without disturbing it", () => {
    const withMwe = buildReproTestPrompt(ISSUE, "import pkg; pkg.Foo().bar()")
    const withBoth = buildReproTestPrompt(ISSUE, "import pkg; pkg.Foo().bar()", "canonical", {
      issueSignatures: ["def bar(self): ..."],
    })
    // MWE grounding block still present, signature block added after it.
    expect(withBoth).toContain(
      "# Known reproduction (the issue author's own minimal working example).",
    )
    expect(withBoth).toContain(SIGNATURE_BLOCK_HEADER)
    expect(withBoth.indexOf("# Known reproduction")).toBeLessThan(
      withBoth.indexOf(SIGNATURE_BLOCK_HEADER),
    )
    expect(withBoth.length).toBeGreaterThan(withMwe.length)
  })
})
