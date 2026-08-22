/**
 * Epic-2 — `parseNodeTest`, pinned to VERBATIM real output captured from
 * `bun test` and `node --test` (run 2026-06-10). Proves a JS/TS failure
 * localizes to a {file,line} — which is what makes the typescript-language-
 * server static enrichment fire for the Evidence Packet (it only enriches a
 * failure that has a file+line). The third case is a representative jest/vitest
 * V8-stack shape (the universal frame format all runners share).
 */
import { describe, expect, test } from "bun:test"
import { parseNodeTest } from "@/tool/testrun/parse"

// ── VERBATIM: bun test (location printed BEFORE the `(fail)` marker) ──────────
const BUN = `bun test v1.3.14 (0d9b296a)

sum.test.ts:
1 | import { test, expect } from "bun:test"
2 | test("adds", () => { expect(2 + 2).toBe(5) })
                                       ^
error: expect(received).toBe(expected)

Expected: 5
Received: 4

      at <anonymous> (/private/tmp/nodeparse/sum.test.ts:2:36)
(fail) adds [0.22ms]

 1 pass
 1 fail
 2 expect() calls
Ran 2 tests across 1 file. [12.00ms]`

// ── VERBATIM: node --test (location printed AFTER the `✖` marker) ─────────────
const NODE_TEST = `✖ adds (1.013666ms)
✔ ok (0.064292ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70.79575

✖ failing tests:

test at nt.test.mjs:3:1
✖ adds (1.013666ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  4 !== 5

      at TestContext.<anonymous> (file:///private/tmp/nodeparse/nt.test.mjs:3:29)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1201:25)`

// ── REPRESENTATIVE: jest/vitest V8 frame shape (`at Object (FILE:LINE:COL)`) ──
const JEST = `FAIL  src/math.test.ts
  ✕ adds numbers (4 ms)

  ● adds numbers

    expect(received).toBe(expected)

      at Object.<anonymous> (/repo/src/math.test.ts:7:23)
      at /repo/node_modules/jest-runner/build/run.js:10:1

Tests:       1 failed, 3 passed, 4 total`

describe("parseNodeTest", () => {
  test("bun test: localizes the failure to {file,line} + message + counts", () => {
    const r = parseNodeTest(BUN)
    expect(r.runner).toBe("node")
    expect(r.ok).toBe(false)
    expect(r.passed).toBe(1)
    expect(r.failed.length).toBe(1)
    const f = r.failed[0]!
    expect(f.name).toBe("adds")
    expect(f.file).toBe("/private/tmp/nodeparse/sum.test.ts")
    expect(f.line).toBe(2)
    expect(f.message).toContain("expect(received).toBe(expected)")
  })

  test("node --test: localizes the failure (deduping the doubled ✖ marker)", () => {
    const r = parseNodeTest(NODE_TEST)
    expect(r.runner).toBe("node")
    expect(r.ok).toBe(false)
    expect(r.passed).toBe(1)
    // The `✖ adds` marker appears twice (inline + failing-tests section) — deduped.
    expect(r.failed.length).toBe(1)
    const f = r.failed[0]!
    expect(f.name).toBe("adds")
    expect(f.file).toMatch(/nt\.test\.mjs$/)
    expect(f.line).toBe(3)
    expect(f.message).toContain("AssertionError")
  })

  test("jest/vitest V8 shape: ✕ marker + first USER frame (skips node_modules)", () => {
    const r = parseNodeTest(JEST)
    expect(r.runner).toBe("node")
    expect(r.ok).toBe(false)
    expect(r.passed).toBe(3)
    const f = r.failed[0]!
    expect(f.name).toBe("adds numbers")
    // The node_modules frame is skipped; the user source frame wins.
    expect(f.file).toBe("/repo/src/math.test.ts")
    expect(f.line).toBe(7)
  })

  test("green run ⇒ no failures, ok:true", () => {
    const r = parseNodeTest("bun test v1.3.14\n\n 4 pass\n 0 fail\nRan 4 tests across 2 files.")
    expect(r.ok).toBe(true)
    expect(r.passed).toBe(4)
    expect(r.failed.length).toBe(0)
  })

  test("NEVER-throws on garbage", () => {
    expect(() => parseNodeTest("\x00 not test output \n garbage \n")).not.toThrow() // \x00 = escaped NUL, never a raw byte (source-NUL ratchet)
    expect(parseNodeTest("random noise").ok).toBe(true) // no markers, no frames ⇒ vacuously green (exit-code net catches real fails)
  })
})

// VERBATIM mocha output (captured 2026-06-10): `N failing` count + numbered
// `N) name` summary list; the stack frame `at ... (file:line:col)` localizes.
const MOCHA = [
  "",
  "  math suite",
  "    1) adds correctly",
  "",
  "  0 passing (3ms)",
  "  1 failing",
  "",
  "  1) math suite",
  "       adds correctly:",
  "",
  "      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "",
  "10 !== 99",
  "",
  "      at Context.<anonymous> (sum.test.js:6:12)",
  "      at process.processImmediate (node:internal/timers:504:21)",
].join("\n")

describe("parseNodeTest — mocha", () => {
  test("harvests the failing test from the numbered list + localizes via the frame", () => {
    const r = parseNodeTest(MOCHA)
    expect(r.ok).toBe(false)
    expect(r.failed.length).toBe(1)
    const f = r.failed[0]!
    expect(f.name).toBe("adds correctly") // summary `1) adds correctly`, NOT the detail `1) math suite`
    expect(f.file).toBe("sum.test.js")
    expect(f.line).toBe(6)
    expect(f.message).toContain("AssertionError")
  })
})

// VERBATIM jest output (captured 2026-06-10). Default reporter uses `● name`
// bullets (NOT ✕) + V8 frame `at ... (file:line:col)` + `Tests: N failed`.
const JEST_REAL = [
  "FAIL ./sum.test.js",
  "  ● fails",
  "",
  "    expect(received).toBe(expected) // Object.is equality",
  "",
  "    Expected: 99",
  "    Received: 10",
  "",
  '      2 | test("fails", () => {',
  "      3 |   const result = compute(5)",
  "    > 4 |   expect(result).toBe(99)",
  "        |                  ^",
  "      5 | })",
  "",
  "      at Object.toBe (sum.test.js:4:18)",
  "",
  "Tests:       1 failed, 1 total",
].join("\n")

describe("parseNodeTest — jest default reporter (● bullet)", () => {
  test("localizes via the ● marker + V8 frame", () => {
    const r = parseNodeTest(JEST_REAL)
    expect(r.ok).toBe(false)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.name).toBe("fails")
    expect(r.failed[0]?.file).toBe("sum.test.js")
    expect(r.failed[0]?.line).toBe(4)
  })
})

// VERBATIM-shaped bun output, TWO failures, where the FIRST failure's stack has
// a HELPER frame above the test frame (assertEq called from the test). The old
// flat-index zip (`locs[i]`) mis-pairs: it has THREE frames for TWO failures, so
// failure #2 inherits failure #1's SECOND frame (`one.test.ts`) — a confidently
// WRONG file:line that mis-localizes the Evidence Packet's debugger. The marker-
// scoped association binds each failure to the frame that sits next to ITS own
// `(fail)` marker.
const BUN_MULTI = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "multi.test.ts:",
  "error: expect(received).toBe(expected)",
  "Expected: 5",
  "Received: 4",
  "      at assertEq (/tmp/m/helper.ts:3:5)",
  "      at <anonymous> (/tmp/m/one.test.ts:7:10)",
  "(fail) one [0.20ms]",
  "error: expect(received).toBe(expected)",
  "Expected: 9",
  "Received: 0",
  "      at <anonymous> (/tmp/m/two.test.ts:4:8)",
  "(fail) two [0.10ms]",
  "",
  " 0 pass",
  " 2 fail",
  "Ran 2 tests across 1 file. [12.00ms]",
].join("\n")

describe("parseNodeTest — multi-failure association (positional mis-pairing regression)", () => {
  test("each failure gets ITS OWN frame, not the next failure's", () => {
    const r = parseNodeTest(BUN_MULTI)
    expect(r.failed).toHaveLength(2)
    const one = r.failed.find((f) => f.name === "one")
    const two = r.failed.find((f) => f.name === "two")
    // failure #1 localizes to its deepest user frame (the assertion in the helper)
    expect(one?.file).toBe("/tmp/m/helper.ts")
    expect(one?.line).toBe(3)
    // failure #2 MUST land on two.test.ts — NOT one.test.ts (the old-zip bug)
    expect(two?.file).toBe("/tmp/m/two.test.ts")
    expect(two?.line).toBe(4)
  })

  test("single-failure localization is unchanged (no regression)", () => {
    const r = parseNodeTest(BUN)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.file).toBe("/private/tmp/nodeparse/sum.test.ts")
    expect(r.failed[0]?.line).toBe(2)
  })
})
