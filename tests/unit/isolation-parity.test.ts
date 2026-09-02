/**
 * ★ HELLGATE — a `pure` chunk means the same thing with and without isolation.
 *
 * WHY THIS EXISTS. The shard runner passes `--parallel=1` to every worker, and
 * in Bun that flag IMPLIES `--isolate`: one worker process, but a fresh global
 * per test file. So the suite pays the entire isolation cost and gets none of
 * the parallelism. Measured by counting preload evaluations (a count, which load
 * cannot distort): 5 test files ran the bunfig preload ONCE with no flag and
 * FIVE times under `--parallel=1`. On a real 156-file `pure` chunk, back to back
 * at load 40-47: 82.5s isolated vs 40.5s not — 2x.
 *
 * The classifier already answers whether that is safe. `pure` is defined as
 * owning no process-global or checkout-global resource, and the runner's own
 * comment says running two NON-pure files in one process "is precisely what the
 * class system exists to prevent". Isolation buys a `pure` file nothing.
 *
 * But "buys nothing" is a claim about 2,946 files, and dropping isolation is a
 * SEMANTIC change, not a tuning knob. So this is the evidence the change rests
 * on: run a corpus both ways and compare per-test outcomes. A disagreement does
 * not mean "keep isolation" — it means that file is not `pure` and the
 * CLASSIFIER is wrong.
 *
 * This file pins the comparison logic. The rail that runs a real corpus through
 * it is `tools/dev/isolation-parity.ts`.
 */

import { describe, expect, test } from "bun:test"
import { compareIsolationRuns, parseJunitOutcomes } from "../../tools/dev/isolation-parity"

/**
 * Bun's REAL shape, not a convenient one: a passing case is a SELF-CLOSING
 * `<testcase … />` and a failing case is an open tag with a `<failure>` child.
 *
 * The first fixture here emitted an open tag for both, so the parser's inability
 * to read a self-closing tag was invisible — a real 2,251-case run compared as
 * 212, and every test still passed. A fixture that cannot express the producer's
 * output does not test the parser.
 */
const junit = (cases: readonly (readonly [string, string, boolean])[]): string =>
  [
    '<?xml version="1.0"?>',
    "<testsuites>",
    ...cases.map(([file, name, ok]) =>
      ok
        ? `<testcase name="${name}" classname="c" time="0.01" file="${file}" line="1" assertions="1" />`
        : `<testcase name="${name}" classname="c" time="0.01" file="${file}" line="1"><failure message="x" /></testcase>`,
    ),
    "</testsuites>",
  ].join("\n")

describe("parseJunitOutcomes — a verdict per test, keyed by file+name", () => {
  test("reads pass and fail", () => {
    const out = parseJunitOutcomes(
      junit([
        ["a.test.ts", "one", true],
        ["a.test.ts", "two", false],
      ]),
    )

    expect(out.get("a.test.ts one")).toBe("pass")
    expect(out.get("a.test.ts two")).toBe("fail")
  })

  test("two same-named tests in different files stay distinct", () => {
    // A disagreement in one must not be masked by the other.
    const out = parseJunitOutcomes(
      junit([
        ["a.test.ts", "same", true],
        ["b.test.ts", "same", false],
      ]),
    )

    expect(out.size).toBe(2)
  })

  test("a SELF-CLOSING passing case is read — the shape Bun actually emits", () => {
    // The regression this pins: a parser that only matched `<testcase …>` read
    // failures (open tags) and dropped every pass. On a real chunk that turned
    // 2,251 cases into 212 while reporting "parity".
    const out = parseJunitOutcomes(
      '<testsuites><testcase name="p" classname="c" time="0.01" file="a.test.ts" /></testsuites>',
    )

    expect(out.get("a.test.ts p")).toBe("pass")
    expect(out.size).toBe(1)
  })

  test("a failure child belongs to its OWN case, not the next one", () => {
    // A self-closing pass followed by a failing case: scanning past the first
    // tag for a `<failure>` would mark the pass as failed.
    const out = parseJunitOutcomes(
      [
        "<testsuites>",
        '<testcase name="p" classname="c" file="a.test.ts" />',
        '<testcase name="f" classname="c" file="a.test.ts"><failure message="x" /></testcase>',
        "</testsuites>",
      ].join("\n"),
    )

    expect(out.get("a.test.ts p")).toBe("pass")
    expect(out.get("a.test.ts f")).toBe("fail")
  })

  test("ANTI-VACUITY — an empty document yields nothing, never a confident empty agreement", () => {
    expect(parseJunitOutcomes("<testsuites></testsuites>").size).toBe(0)
  })
})

describe("compareIsolationRuns — what counts as parity", () => {
  test("identical outcomes are parity", () => {
    const x = junit([
      ["a.test.ts", "one", true],
      ["a.test.ts", "two", true],
    ])

    expect(compareIsolationRuns(x, x)).toEqual({ kind: "parity", compared: 2 })
  })

  test("a test that passes isolated and fails shared is reported WITH its file", () => {
    const isolated = junit([["a.test.ts", "one", true]])
    const shared = junit([["a.test.ts", "one", false]])

    const result = compareIsolationRuns(isolated, shared)

    expect(result.kind).toBe("divergence")
    if (result.kind === "divergence") {
      expect(result.rows).toEqual([
        { file: "a.test.ts", name: "one", isolated: "pass", shared: "fail" },
      ])
    }
  })

  test("a test MISSING from one side is a divergence, not a silent skip", () => {
    // The failure mode this guards: a shared run that crashes early emits fewer
    // testcases, and a naive intersection would call the survivors "parity".
    const isolated = junit([
      ["a.test.ts", "one", true],
      ["a.test.ts", "two", true],
    ])
    const shared = junit([["a.test.ts", "one", true]])

    const result = compareIsolationRuns(isolated, shared)

    expect(result.kind).toBe("divergence")
    if (result.kind === "divergence") {
      expect(result.rows).toEqual([
        { file: "a.test.ts", name: "two", isolated: "pass", shared: "absent" },
      ])
    }
  })

  test("a test present only in the SHARED run is also a divergence", () => {
    // The mirror of the case above. Checking one direction only would let a
    // comparator that walks just the isolated keys call this parity — which is
    // exactly what an intersection-based implementation does.
    const isolated = junit([["a.test.ts", "one", true]])
    const shared = junit([
      ["a.test.ts", "one", true],
      ["a.test.ts", "two", true],
    ])

    const result = compareIsolationRuns(isolated, shared)

    expect(result.kind).toBe("divergence")
    if (result.kind === "divergence") {
      expect(result.rows).toEqual([
        { file: "a.test.ts", name: "two", isolated: "absent", shared: "pass" },
      ])
    }
  })

  test("an absent side is reported as absent, never borrowed from the other run", () => {
    // Guards the shape where a missing outcome silently inherits the peer's
    // verdict: the row would then read pass/pass and vanish as parity.
    const isolated = junit([["a.test.ts", "only-here", true]])
    const shared = junit([["b.test.ts", "only-there", true]])

    const result = compareIsolationRuns(isolated, shared)

    expect(result.kind).toBe("divergence")
    if (result.kind === "divergence") {
      expect(result.rows).toHaveLength(2)
      expect(result.rows.map((r) => `${r.isolated}/${r.shared}`).sort()).toEqual([
        "absent/pass",
        "pass/absent",
      ])
    }
  })

  test("PAIRED CONTROL — both sides failing the same test is parity, not a divergence", () => {
    // A genuinely broken test is not an isolation problem, and reporting it here
    // would drown the signal this rail exists to find.
    const x = junit([["a.test.ts", "one", false]])

    expect(compareIsolationRuns(x, x).kind).toBe("parity")
  })

  test("an EMPTY comparison is refused — zero tests is not agreement", () => {
    const result = compareIsolationRuns("<testsuites></testsuites>", "<testsuites></testsuites>")

    expect(result.kind).toBe("empty")
  })
})
