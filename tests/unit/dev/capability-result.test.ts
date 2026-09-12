/**
 * The artifact that tells a green capability job from a green capability job
 * that executed nothing.
 *
 * Three producers behind `required` are capability lanes: `pty` (every describe
 * in tests/e2e-pty is `skipIf(!PTY_AVAILABLE)`), `toolchain` (the `*-real-e2e`
 * arms degrade to visible skips without clangd / lldb-dap / dlv / debugpy), and
 * `contract` (docker, language servers, Python + LanceDB). On a runner missing
 * the capability each exits 0 having run nothing, GitHub reports `success`, and
 * no count of green rows can tell that apart from full coverage.
 *
 * Measured end-to-end while building this: a file whose every case is skipped
 * produces `executedCases: 0`, and the required aggregator then exits 1 with
 * `capability producer "pty" executed 0 case(s), floor is 1`.
 */

import { describe, expect, test } from "bun:test"

import {
  capabilityResultForMissingJunit,
  capabilityResultFromJunit,
  countJunitExecution,
} from "../../../tools/dev/capability-result"

const junit = (cases: string): string =>
  `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`

describe("capability-result", () => {
  test("a skipped case is not executed, and its file does not count", () => {
    const xml = junit(
      `<testcase name="a" file="tests/e2e-pty/x.test.ts"><skipped/></testcase>` +
        `<testcase name="b" file="tests/e2e-pty/x.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedCases: 2,
    })
  })

  test("a failing case IS executed — it is coverage that found something", () => {
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><failure message="boom"/></testcase>` +
        `<testcase name="b" file="f.test.ts"/>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 2,
      executedCasesByFile: { "f.test.ts": 2 },
      skippedCases: 0,
    })
  })

  test("a file with one live case among skips counts once", () => {
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><skipped/></testcase>` +
        `<testcase name="b" file="f.test.ts"/>` +
        `<testcase name="c" file="g.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 1,
      executedCasesByFile: { "f.test.ts": 1 },
      skippedCases: 2,
    })
  })

  test("self-closing and block forms are both read", () => {
    const xml = junit(
      `<testcase name="a" file="f.test.ts"/><testcase name="b" file="f.test.ts">` +
        `<system-out>noise</system-out></testcase>`,
    )
    expect(countJunitExecution(xml).executedCases).toBe(2)
  })

  test("classname stands in when no file attribute is emitted", () => {
    const xml = junit(`<testcase name="a" classname="pkg.Thing"/>`)
    expect(countJunitExecution(xml).executedFiles).toEqual(["pkg.Thing"])
  })

  test("an all-skipped lane produces the zero-execution artifact", () => {
    const result = capabilityResultFromJunit({
      producer: "pty",
      xml: junit(`<testcase name="a" file="f.test.ts"><skipped/></testcase>`),
    })
    expect(result).toEqual({
      schema: "quanta.capability-result.v2",
      producer: "pty",
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedUnsupported: 1,
      blockedMissing: 0,
      failedSetup: 0,
    })
  })

  test("a missing JUnit is failedSetup, not zero skips", () => {
    // The difference is whether the lane chose not to run or never got the
    // chance. Both fail at the aggregator; only one is a provisioning defect,
    // and publishing nothing at all would read as a lost upload instead.
    const result = capabilityResultForMissingJunit("contract")
    expect(result.failedSetup).toBe(1)
    expect(result.skippedUnsupported).toBe(0)
    expect(result.executedCases).toBe(0)
  })

  test("blocked and setup-failed counts are carried through", () => {
    const result = capabilityResultFromJunit({
      producer: "contract",
      xml: junit(`<testcase name="a" file="f.test.ts"/>`),
      blockedMissing: 2,
      failedSetup: 1,
    })
    expect({ blocked: result.blockedMissing, setup: result.failedSetup }).toEqual({
      blocked: 2,
      setup: 1,
    })
  })

  test("a skip elsewhere in the document does not unexecute a BLOCK-form case", () => {
    // Mutation survivor: `skipped = /<skipped\b/.test(body)` -> `.test(xml)`
    // passed every fixture, because each fixture's EXECUTED case was
    // self-closing and so never entered the body branch at all. That is not the
    // shape a real lane emits — Bun writes `<testcase …>` with children for any
    // case that produced output, beside `<skipped />` siblings for the rest.
    const xml = junit(
      `<testcase name="ran" file="f.test.ts"><system-out>hello</system-out></testcase>` +
        `<testcase name="did not" file="f.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 1,
      executedCasesByFile: { "f.test.ts": 1 },
      skippedCases: 1,
    })

    // …and the document-scoped reading really would get this wrong, which is
    // what makes the assertion above load-bearing rather than incidental.
    const documentScoped = /<skipped\b/u.test(xml)
    expect(documentScoped).toBe(true)
  })

  test("the first block-form case is not unexecuted by a LATER skip", () => {
    // Ordering matters for a scan: a document-scoped test also mis-reads the
    // case that comes BEFORE the skip, which is the common layout when a lane
    // runs a few arms and skips the rest.
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><system-out>x</system-out></testcase>` +
        `<testcase name="b" file="g.test.ts"><skipped/></testcase>` +
        `<testcase name="c" file="h.test.ts"><failure message="boom"/></testcase>`,
    )
    const counts = countJunitExecution(xml)
    expect(counts.executedFiles).toEqual(["f.test.ts", "h.test.ts"])
    expect(counts.executedCases).toBe(2)
    expect(counts.skippedCases).toBe(1)
  })

  test("an empty report is zero, not a crash", () => {
    expect(countJunitExecution(junit(""))).toEqual({
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedCases: 0,
    })
  })
})
