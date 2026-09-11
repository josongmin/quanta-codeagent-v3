/**
 * `tools/test-resilience/junit` — per-test outcomes from a diagnostic child.
 *
 * # Why JUnit and not the text reporter
 *
 * MEASURED on Bun 1.3.14: the default reporter prints a line for FAILURES only.
 * A batched child that runs five selected tests and prints "4 pass · 1 fail"
 * therefore cannot say WHICH four passed — and "this test passed in isolation"
 * is precisely the claim the diagnosis is making. Inferring it from counts is
 * how a silently-filtered test becomes an `observed-isolation-pass`.
 *
 * `--reporter=junit` emits one `<testcase>` per executed test with its name and
 * its describe chain, so every claim is per-test and positive.
 *
 * # The two shapes this has to know
 *
 * MEASURED (same version), for `describe("outer") > describe("inner") > test("leaf")`:
 *
 * ```xml
 * <testcase name="leaf one" classname="inner &amp;gt; outer" file="c.test.ts" line="4" />
 * <testcase name="leaf two" classname="inner &amp;gt; outer" …>
 *   <failure type="AssertionError" />
 * </testcase>
 * ```
 *
 *  1. `classname` is the describe chain REVERSED (innermost first).
 *  2. It is DOUBLE-escaped: the separator arrives as `&amp;gt;`, which is
 *     `&gt;` after one unescape and `>` after two. Unescaping once and then
 *     splitting on either spelling handles both, and would keep working if the
 *     double escape were ever fixed.
 *
 * A self-closing `<testcase/>` is a pass; a `<failure>` or `<error>` child is a
 * failure; `<skipped>` is neither and must not read as green.
 */

export type JunitStatus = "pass" | "fail" | "skip"

export interface JunitCase {
  /** `describe > … > leaf`, reconstructed to match the text reporter's format. */
  readonly testId: string
  readonly leaf: string
  readonly file: string
  readonly status: JunitStatus
  readonly elapsedMs: number
}

const unescapeOnce = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")

const attribute = (attributes: string, name: string): string => {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)
  return match?.[1] === undefined ? "" : unescapeOnce(match[1])
}

/** `"inner &gt; outer"` → `["outer", "inner"]`. Empty for a top-level test. */
export const describeChain = (classname: string): readonly string[] =>
  classname
    .split(/\s*(?:&gt;|>)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .reverse()

const CASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g

export const parseJunitCases = (xml: string): readonly JunitCase[] => {
  const cases: JunitCase[] = []
  for (const match of xml.matchAll(CASE)) {
    const attributes = match[1] ?? ""
    const body = match[3] ?? ""
    const leaf = attribute(attributes, "name")
    if (leaf === "") continue
    const chain = describeChain(attribute(attributes, "classname"))
    const failed = body.includes("<failure") || body.includes("<error")
    const skipped = body.includes("<skipped")
    cases.push({
      testId: [...chain, leaf].join(" > "),
      leaf,
      file: attribute(attributes, "file"),
      status: failed ? "fail" : skipped ? "skip" : "pass",
      elapsedMs: Math.round(Number(attribute(attributes, "time") || "0") * 1_000),
    })
  }
  return cases
}

/**
 * Bun's own signal that `-t` selected nothing.
 *
 * MEASURED: `error: regex "zzz" matched 0 tests. Searched 1 file (skipping 3
 * tests)` on stderr, with a non-zero exit and NO junit file. This is the one
 * case the old code escalated to a whole-file re-run; it is now a first-class
 * `inconclusive`, because a selector that matched nothing is evidence about the
 * SELECTOR, not about the test.
 */
export const selectorMatchedNothing = (output: string): boolean => /matched 0 tests/.test(output)
