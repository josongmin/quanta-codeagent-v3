/**
 * ★ HELLGATE — a `pure` chunk means the same thing however its files share a
 * process.
 *
 * WHY THIS EXISTS. The runner packs `pure` files into one chunk and hands that
 * chunk `--parallel=N` (up to 8), so N of them run CONCURRENTLY inside a single
 * worker; every other class gets `--parallel=1`, because two files that own a
 * port, a browser or the working tree must not share a process. That asymmetry
 * rests entirely on the `pure` definition, and the measurement behind it covered
 * 24 files.
 *
 * MEASURED at corpus scale (2026-09-03, 2,946 files / 36,359 cases, both sides
 * at the runner's 120,000 ms timeout): `--parallel=1` 10m10s, no flag 3m34s,
 * `--parallel=8` 2m14s — all three 36,325 pass / 2 fail, PARITY in every pairing
 * (36,188 compared, zero divergences). The runner's configuration is the fastest
 * AND verdict-clean; removing isolation would be a 60% regression, since the win
 * came from concurrency rather than from dropping isolation.
 *
 * A disagreement would NOT mean "share less" — it would mean that file owns
 * shared state and the CLASSIFIER is wrong.
 *
 * This file pins the comparison logic. The rail that runs a real corpus through
 * it is `tools/dev/isolation-parity.ts`, whose header carries the measurement
 * and the timeout confound that ruined the first attempt.
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
