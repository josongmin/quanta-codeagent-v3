/**
 * `tools/dev/isolation-parity` — evidence that a `pure` corpus means the same
 * thing however its files share a process.
 *
 * # Why
 * `pure` is defined as owning no process-global or checkout-global resource, and
 * the runner leans on that definition twice: it packs `pure` files into one
 * chunk, and it hands that chunk `--parallel=N` (up to 8) so N of them run
 * CONCURRENTLY inside a single worker. Every other class gets `--parallel=1`,
 * because running two files that own a port, a browser or the working tree in
 * one process is what the class system exists to prevent.
 *
 * That is a claim about thousands of files resting on a definition, and the
 * measurement that justified it covered 24. This rail is the corpus-scale
 * version: run the same corpus under different sharing and compare per-test
 * outcomes.
 *
 * # Measured (2026-09-03, 2,946 files / 36,359 cases, all at the runner's
 * 120,000 ms timeout, idle box)
 *
 *   --parallel=1   isolated, sequential   10m10s
 *   no flag        shared,   sequential    3m34s
 *   --parallel=8   isolated, concurrent    2m14s   <- what the runner does
 *
 * All three: 36,325 pass / 2 fail, and PARITY in every pairing (36,188 compared,
 * zero divergences). So the corpus really is insensitive to how it shares a
 * process, and the runner's configuration is both the fastest and verdict-clean.
 *
 * Dropping isolation is therefore NOT an optimisation — at 3m34s it is a 60%
 * regression against the 2m14s the runner already achieves. Concurrency, not the
 * absence of isolation, is where the time went.
 *
 * # What a divergence means
 * NOT "share less". It means the file owns shared state and is therefore not
 * `pure` — the CLASSIFIER is what should change. Reporting the file is the
 * point: a rail that only said "differs" would send someone hunting.
 *
 * # Why absence is a divergence
 * A run that dies early emits fewer testcases. Comparing only the intersection
 * would call the survivors parity and hide exactly the crash this rail exists to
 * catch, so a test present on one side and missing on the other is a divergence
 * with `absent` named as its outcome.
 *
 * # Run both sides at the SAME timeout
 * The first attempt did not, and reported 321 divergences that were all
 * artefact. It used bare `bun test`, taking Bun's 5,000 ms default while the
 * runner scales from a 120,000 ms base — 24x tighter. Isolation is ~2.8x slower,
 * so the confound did not cancel: hooks timed out 56 times against 1, and a
 * timed-out `beforeEach` aborts the whole FILE, collapsing 125 cases into a
 * single `(unnamed)` failure that reads as mass absence. Pinning both sides at
 * the runner's timeout is what makes this a difference measurement.
 */

export type TestOutcome = "pass" | "fail"

export type IsolationParityResult =
  | { readonly kind: "parity"; readonly compared: number }
  | { readonly kind: "empty" }
  | {
      readonly kind: "divergence"
      readonly rows: readonly {
        readonly file: string
        readonly name: string
        readonly isolated: TestOutcome | "absent"
        readonly shared: TestOutcome | "absent"
      }[]
    }

/**
 * One verdict per test, keyed by `file + " " + name`.
 *
 * Keyed on BOTH because two files may hold same-named tests, and collapsing
 * them would let one file's disagreement be masked by another's agreement.
 * Bun writes `<testcase …>` with a `<failure/>` child for a failing test, so a
 * self-closing tag is a pass.
 */
export const parseJunitOutcomes = (xml: string): ReadonlyMap<string, TestOutcome> => {
  const outcomes = new Map<string, TestOutcome>()
  // Bun writes a SELF-CLOSING `<testcase … />` for a pass and an open tag with a
  // `<failure>` child for a failure. Matching only `<testcase …>` caught the
  // second shape and silently dropped the first: a real 2,251-case run compared
  // as 2. The `/?` and the optional body are what make both shapes parse.
  // Bun writes a SELF-CLOSING `<testcase … />` for a pass and an OPEN tag with a
  // `<failure>` / `<error>` child for a failure. Scan tag-by-tag rather than
  // trying to match a tag AND its optional body in one expression: the combined
  // pattern consumed the text between a self-closing tag and the next open one,
  // and a real 2,251-case run parsed as 212.
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/?)>/g)) {
    const attrs = match[1] ?? ""
    const selfClosing = match[2] === "/"
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1]
    if (name === undefined) continue
    const file = /\bfile="([^"]*)"/.exec(attrs)?.[1] ?? "<unknown>"
    // Only an OPEN tag can carry a failure child; look no further than the next
    // `</testcase>` so a later failure cannot be attributed to this case.
    const after = xml.slice((match.index ?? 0) + match[0].length)
    const end = after.indexOf("</testcase>")
    const body = selfClosing || end < 0 ? "" : after.slice(0, end)
    const failed = body.includes("<failure") || body.includes("<error")
    outcomes.set(`${file} ${name}`, failed ? "fail" : "pass")
  }
  return outcomes
}

const split = (key: string): { file: string; name: string } => {
  const at = key.indexOf(" ")
  return at < 0
    ? { file: "<unknown>", name: key }
    : { file: key.slice(0, at), name: key.slice(at + 1) }
}

/**
 * Compare an isolated run against a shared-global run of the SAME corpus.
 *
 * A test both runs agree on — including one they agree is broken — is parity: a
 * genuinely failing test is not an isolation defect, and surfacing it here would
 * drown the signal.
 */
export const compareIsolationRuns = (
  isolatedXml: string,
  sharedXml: string,
): IsolationParityResult => {
  const isolated = parseJunitOutcomes(isolatedXml)
  const shared = parseJunitOutcomes(sharedXml)
  if (isolated.size === 0 && shared.size === 0) return { kind: "empty" }
  const rows: {
    file: string
    name: string
    isolated: TestOutcome | "absent"
    shared: TestOutcome | "absent"
  }[] = []
  for (const key of new Set([...isolated.keys(), ...shared.keys()])) {
    const left = isolated.get(key) ?? "absent"
    const right = shared.get(key) ?? "absent"
    if (left === right) continue
    rows.push({ ...split(key), isolated: left, shared: right })
  }
  return rows.length === 0
    ? { kind: "parity", compared: isolated.size }
    : { kind: "divergence", rows }
}
