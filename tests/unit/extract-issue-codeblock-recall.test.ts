import { describe, expect, test } from "bun:test"
import { extractIssueDeclaredExpected } from "@/agent/verification-plan"

/**
 * Recall extension (gap-B): the expected output is frequently declared inside a
 * FENCED CODE BLOCK after an explicit desired-output marker ("should be:",
 * "better to be ... to:", "expected output:"), NOT as an inline "should return
 * `X`". The fail-closed inline extractor caught only 1/7 of the oracle slice
 * because of this. This adds high-precision code-block recall WITHOUT loosening
 * fail-closed: a fenced block with NO desired-output marker still yields nothing.
 *
 * Red-on-injection: remove the code-block branch ⇒ REC-1/REC-3 RED. Loosen it to
 * fire on any fenced literal (drop the marker requirement) ⇒ REC-2/REC-4 RED.
 */

// Real sympy-18763 shape: input block + "gives" (incorrect) block + the DESIRED
// "better to be ... to:" block. The marker must anchor on the LAST (correct) one.
const SYMPY_18763 = `Incorrect parenthesizing of Subs
\`\`\`python
>>> 3*Subs(-x+y, (x,),(1,))
\`\`\`
LaTeX printing of this gives:
\`\`\`python
'3 \\left. - x + y \\right|_{\\substack{ x=1 }}'
\`\`\`
It would be better to be parenthesized to:
\`\`\`python
'3 \\left. \\left(- x + y\\right) \\right|_{\\substack{ x=1 }}'
\`\`\`
`

const SHOULD_BE = `The repr is wrong. It should be:
\`\`\`
'Matrix([[1, 2]])'
\`\`\`
`

// Control: a code block with NO desired-output marker (just an example) ⇒ no fire.
const NO_MARKER = `Here is an example of the crash:
\`\`\`python
foo(bar)
\`\`\`
`

// Control: a desired-output marker but NO delimited literal in the block ⇒ no fire.
const MARKER_NO_LITERAL = `The output should be: the parenthesized form, roughly.
\`\`\`
(no quoted literal here)
\`\`\`
`

describe("gap-B code-block expected-output recall", () => {
  test("REC-1: sympy-18763 'better to be ... to:' code block ⇒ fires on the DESIRED (parenthesized) literal", () => {
    const r = extractIssueDeclaredExpected(SYMPY_18763)
    expect(r).not.toBeUndefined()
    // must be the CORRECT (parenthesized) output, not the incorrect "gives" one
    expect(r?.value).toContain("\\left(")
    expect(r?.kind).toBe("latex")
  })

  test("REC-2: code block with NO desired-output marker ⇒ no fire (fail-closed preserved)", () => {
    expect(extractIssueDeclaredExpected(NO_MARKER)).toBeUndefined()
  })

  test("REC-3: 'should be:' + code block literal ⇒ fires", () => {
    const r = extractIssueDeclaredExpected(SHOULD_BE)
    expect(r).not.toBeUndefined()
    expect(r?.value).toContain("Matrix")
  })

  test("REC-4: desired marker but block has no delimited literal ⇒ no fire (precision)", () => {
    expect(extractIssueDeclaredExpected(MARKER_NO_LITERAL)).toBeUndefined()
  })
})
