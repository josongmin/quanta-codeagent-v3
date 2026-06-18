import { describe, expect, test } from "bun:test"
import { extractIssueRepro } from "@/agent/verification-plan/extract-issue-repro"

/**
 * issue→repro extractor (closure repro-install lever). FAIL-CLOSED: only a
 * confidently-executable python fence; never a quoted output block; ambiguous ⇒
 * undefined (a wrong repro would gate the rail on a non-reproducing script).
 */
describe("extractIssueRepro", () => {
  test("fenced ```python MWE ⇒ extracted", () => {
    const ps = "Bug.\n\n```python\nimport inspect\nfrom sympy import lambdify\ninspect.getsource(lambdify([], tuple([1])))\n```\nSymPy 1.9 outputs:\n```\n'def x():\\n  return (1,)\\n'\n```"
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
    expect(extractIssueRepro("```\n'def _lambdifygenerated():\\n    return (1,)\\n'\n```")).toBeUndefined()
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
    expect(extractIssueRepro("```\nimport os\nos.getcwd()\n```")?.code).toBe("import os\nos.getcwd()")
  })
})
