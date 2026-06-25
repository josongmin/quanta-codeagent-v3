import { describe, expect, test } from "bun:test"
import {
  extractIssueRepro,
  extractIssueReproSeed,
} from "@/agent/verification-plan/extract-issue-repro"

/**
 * issue→repro extractor (closure repro-install lever). FAIL-CLOSED: only a
 * confidently-executable python fence; never a quoted output block; ambiguous ⇒
 * undefined (a wrong repro would gate the rail on a non-reproducing script).
 */
describe("extractIssueRepro", () => {
  test("fenced ```python MWE ⇒ extracted", () => {
    const ps =
      "Bug.\n\n```python\nimport inspect\nfrom sympy import lambdify\ninspect.getsource(lambdify([], tuple([1])))\n```\nSymPy 1.9 outputs:\n```\n'def x():\\n  return (1,)\\n'\n```"
    const r = extractIssueRepro(ps)
    expect(r?.code).toContain("from sympy import lambdify")
    expect(r?.code).toContain("inspect.getsource")
  })

  test("first EXECUTABLE block wins; the quoted-output block after it is skipped", () => {
    const ps = "```python\nimport x\nx.run()\n```\n```\n'output value'\n```"
    expect(extractIssueRepro(ps)?.code).toBe("import x\nx.run()")
  })

  test("pycon / doctest >>> block ⇒ stripped to runnable", () => {
    const ps = "```pycon\n>>> from a import b\n>>> b(1)\n3\n```"
    expect(extractIssueRepro(ps)?.code).toBe("from a import b\nb(1)")
  })

  test("FAIL-CLOSED: a quoted-output-only block ⇒ undefined (it's the expected output, not a repro)", () => {
    expect(
      extractIssueRepro("```\n'def _lambdifygenerated():\\n    return (1,)\\n'\n```"),
    ).toBeUndefined()
  })

  test("FAIL-CLOSED: non-python fence (shell/json) ⇒ undefined", () => {
    expect(extractIssueRepro("```bash\nnpm install\n```")).toBeUndefined()
    expect(extractIssueRepro('```json\n{"a":1}\n```')).toBeUndefined()
  })

  test("FAIL-CLOSED: no fenced code ⇒ undefined", () => {
    expect(extractIssueRepro("The MathML printer drops subscripts in Safari.")).toBeUndefined()
    expect(extractIssueRepro("")).toBeUndefined()
    expect(extractIssueRepro(undefined)).toBeUndefined()
  })

  test("unlabelled fence with executable python ⇒ extracted", () => {
    expect(extractIssueRepro("```\nimport os\nos.getcwd()\n```")?.code).toBe(
      "import os\nos.getcwd()",
    )
  })

  test("HTML-commented repro fences are ignored", () => {
    const ps = [
      "<!-- ```python",
      "import hidden",
      "hidden.run()",
      "``` -->",
      "```python",
      "import visible",
      "visible.run()",
      "```",
    ].join("\n")
    expect(extractIssueRepro(ps)?.code).toBe("import visible\nvisible.run()")
  })
})

/**
 * T-SMK-04 — the extracted snippet is exposed as a repro SEED, not a standalone
 * gate. The seed carries `provenance: "repro-seed"` so downstream telemetry can
 * distinguish "extracted from issue text" from "validated repro authority".
 */
describe("extractIssueReproSeed (repro-seed provenance)", () => {
  test("executable MWE ⇒ seed carries the SAME code plus repro-seed provenance", () => {
    const ps = "Bug.\n\n```python\nimport x\nx.run()\n```"
    const seed = extractIssueReproSeed(ps)
    expect(seed?.code).toBe(extractIssueRepro(ps)?.code)
    // The provenance tag is what keeps this distinct from validated-repro authority.
    expect(seed?.provenance).toBe("repro-seed")
  })

  test("repro-seed provenance is NOT validated-repro authority (distinct marker)", () => {
    const seed = extractIssueReproSeed("```python\nimport x\nx.run()\n```")
    // A seed is never a validated repro: the marker is the only thing the type
    // exposes, and it is explicitly the heuristic-extraction provenance.
    expect(seed).toBeDefined()
    expect(seed?.provenance).not.toBe("validated-repro")
    expect(seed?.provenance).toBe("repro-seed")
  })

  test("hasCall is a HEURISTIC: an 'Expected output' block with a call is mis-extracted (⇒ must stay seed)", () => {
    // The issue's ONLY fenced block is example OUTPUT, not the repro — but it
    // contains a call (`print(...)`), so the `hasCall` regex matches and the
    // extractor returns it. This is exactly the ambiguous false-positive the bug
    // is about: the value MUST be consumed as a repro-seed (not executed as an
    // authoritative oracle) — its provenance proves it is only a heuristic guess.
    const ps = "The MathML printer drops subscripts.\n\nExpected output:\n```python\nprint('<msub>...</msub>')\n```"
    const seed = extractIssueReproSeed(ps)
    expect(seed?.code).toContain("print(")
    // The marker is the structural guard: a consumer cannot mistake this for a
    // validated repro. Authority is conferred only later by a base-RED gate.
    expect(seed?.provenance).toBe("repro-seed")
  })

  test("FAIL-CLOSED: ambiguous / non-python ⇒ no seed (cannot become repro authority)", () => {
    // A false-positive extraction here would have NO veto power, but precision is
    // still preserved: nothing extractable ⇒ no seed at all.
    expect(extractIssueReproSeed("```\n'quoted output only'\n```")).toBeUndefined()
    expect(extractIssueReproSeed("```bash\nnpm install\n```")).toBeUndefined()
    expect(extractIssueReproSeed("No fenced code here.")).toBeUndefined()
    expect(extractIssueReproSeed(undefined)).toBeUndefined()
  })
})
