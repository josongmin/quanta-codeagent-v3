/**
 * `tools/dev/isolation-parity` — evidence that a `pure` corpus means the same
 * thing with and without Bun's per-file isolation.
 *
 * # Why
 * The shard runner passes `--parallel=1`, and in Bun that flag implies
 * `--isolate`: one worker process, but a fresh global per test file. The suite
 * therefore pays the whole isolation cost for none of the parallelism. Counted
 * (a count, which host load cannot distort): five test files evaluated the
 * bunfig preload ONCE with no flag and FIVE times under `--parallel=1`. On a
 * real 156-file `pure` chunk, back to back at load 40-47: 82.5s isolated vs
 * 40.5s shared.
 *
 * The classifier already decides whether that is safe — `pure` is defined as
 * owning no process-global or checkout-global resource. But that is a claim
 * about thousands of files, and removing isolation changes semantics rather than
 * tuning a number, so it needs evidence rather than an argument.
 *
 * # What a divergence means
 * NOT "put isolation back". It means the file mutates shared state and is
 * therefore not `pure` — the classifier is what should change. Reporting the
 * file is the point: a rail that only said "differs" would send someone hunting.
 *
 * # Why absence is a divergence
 * A shared run that dies early emits fewer testcases. Comparing only the
 * intersection would call the survivors parity and hide exactly the crash this
 * rail exists to catch, so a test present on one side and missing on the other
 * is a divergence with `absent` named as its outcome.
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
  for (const match of xml.matchAll(/<testcase\b([^>]*)>([\s\S]*?)(?:<\/testcase>|$)/g)) {
    const attrs = match[1] ?? ""
    const body = match[2] ?? ""
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1]
    if (name === undefined) continue
    const file = /\bfile="([^"]*)"/.exec(attrs)?.[1] ?? "<unknown>"
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
export const compareIsolationRuns = (isolatedXml: string, sharedXml: string): IsolationParityResult => {
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
