/**
 * Pure-parser tests for `tools/dev/refresh-silent-catch-baseline.ts`.
 *
 * The script's `main()` spawns `bun test` against a forthcoming ratchet
 * file that does not yet exist on trunk; the parsers (idempotent
 * regex-based rewriters) are what we can lock today. Three layers:
 *
 *   1. parseObservedRows  → captures `[silent-catch] id=… observed=… baseline=…`
 *      out of arbitrary bun-test output (anchored keys, deduped by id,
 *      skips truncated lines).
 *   2. findBaselineTable  → locates the canonical `BASELINES` array
 *      literal + parses each row's id, value, and source offsets.
 *   3. planTighten + applyTighten → ratchet-step decision + in-place
 *      string rewrite (NEVER loosens; idempotent on a second pass).
 *
 * Adversarial axes:
 *   - bogus `[silent-catch]` lines from unrelated diagnostics MUST NOT
 *     be parsed as observations.
 *   - a regression (observed > baseline) MUST surface, never silently
 *     overwrite the baseline upward.
 *   - duplicate ids in captured output MUST converge on a single value
 *     (last-write-wins shape is documented).
 *   - rewriter MUST preserve formatting of unaffected rows.
 *   - second-pass apply on the same plan MUST be a no-op (idempotence).
 */
import { describe, expect, test } from "bun:test"
import {
  applyTighten,
  findBaselineTable,
  parseObservedRows,
  planTighten,
} from "../../tools/dev/refresh-silent-catch-baseline"

describe("parseObservedRows", () => {
  test("captures a single canonical row", () => {
    const out = parseObservedRows(
      "noise\n[silent-catch] id=runner.exec observed=3 baseline=7\nmore noise",
    )
    expect(out).toEqual([{ id: "runner.exec", observed: 3 }])
  })

  test("captures multiple distinct ids", () => {
    const text = [
      "[silent-catch] id=A observed=1 baseline=5",
      "[silent-catch] id=B observed=2 baseline=4",
      "[silent-catch] id=C observed=0 baseline=3",
    ].join("\n")
    const out = parseObservedRows(text)
    expect(out).toEqual([
      { id: "A", observed: 1 },
      { id: "B", observed: 2 },
      { id: "C", observed: 0 },
    ])
  })

  test("dedupes repeated id — last value wins", () => {
    const text = [
      "[silent-catch] id=runner.exec observed=5 baseline=7",
      "[silent-catch] id=runner.exec observed=3 baseline=7",
    ].join("\n")
    expect(parseObservedRows(text)).toEqual([{ id: "runner.exec", observed: 3 }])
  })

  test("rejects bogus lines that drop a key (truncated stream guard)", () => {
    const text = [
      "[silent-catch] id=A observed=1", // no baseline
      "[silent-catch] observed=2 baseline=4", // no id
      "[silent-catch] id=B baseline=4", // no observed
      "[silent-catch] id=C observed=2 baseline=4", // good
    ].join("\n")
    expect(parseObservedRows(text)).toEqual([{ id: "C", observed: 2 }])
  })

  test("ignores `id=` strings outside the `[silent-catch]` anchor", () => {
    const text = "some other diagnostic id=fake observed=999 baseline=999\n"
    expect(parseObservedRows(text)).toEqual([])
  })
})

describe("findBaselineTable", () => {
  const SOURCE = `
import { test } from "bun:test"

const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
  { id: "A", observed: 5 },
  { id: "B", observed: 3 },
  { id: "C", observed: 0 },
]

test("noop", () => {})
`

  test("locates the canonical table + parses every row", () => {
    const t = findBaselineTable(SOURCE)
    expect(t).not.toBeNull()
    const ids = (t as NonNullable<typeof t>).rows.map((r) => r.id)
    expect(ids).toEqual(["A", "B", "C"])
    const values = (t as NonNullable<typeof t>).rows.map((r) => r.value)
    expect(values).toEqual([5, 3, 0])
  })

  test("source offsets bracket the row literal exactly", () => {
    const t = findBaselineTable(SOURCE)
    const row = (t as NonNullable<typeof t>).rows[1]
    expect(row).toBeDefined()
    expect(
      SOURCE.slice((row as NonNullable<typeof row>).start, (row as NonNullable<typeof row>).end),
    ).toBe('{ id: "B", observed: 3 }')
  })

  test("refuses a non-canonical declaration shape", () => {
    const drift = SOURCE.replace("ReadonlyArray", "Array")
    expect(findBaselineTable(drift)).toBeNull()
  })

  test("returns null when the table is absent", () => {
    expect(findBaselineTable("// no baselines here")).toBeNull()
  })
})

describe("planTighten", () => {
  const baseline = [
    { id: "A", value: 5, start: 0, end: 0, raw: "" },
    { id: "B", value: 3, start: 0, end: 0, raw: "" },
    { id: "C", value: 0, start: 0, end: 0, raw: "" },
  ]

  test("decreases land in `tightened`", () => {
    const plan = planTighten(baseline, [
      { id: "A", observed: 2 },
      { id: "B", observed: 1 },
      { id: "C", observed: 0 },
    ])
    expect(plan.tightened).toEqual([
      { id: "A", from: 5, to: 2 },
      { id: "B", from: 3, to: 1 },
    ])
    expect(plan.unchanged).toEqual(["C"])
    expect(plan.regressions).toEqual([])
  })

  test("regressions surface (and are NOT auto-tightened)", () => {
    const plan = planTighten(baseline, [
      { id: "A", observed: 99 },
      { id: "B", observed: 3 },
    ])
    expect(plan.regressions).toEqual([{ id: "A", baseline: 5, observed: 99 }])
    expect(plan.tightened).toEqual([])
  })

  test("unknown observed ids surface for manual add", () => {
    const plan = planTighten(baseline, [{ id: "ZZ", observed: 1 }])
    expect(plan.unknownIds).toEqual(["ZZ"])
  })

  test("baseline rows missing from output are conservatively unchanged", () => {
    const plan = planTighten(baseline, [{ id: "A", observed: 4 }])
    expect(plan.tightened).toEqual([{ id: "A", from: 5, to: 4 }])
    expect(plan.missingFromOutput).toEqual(["B", "C"])
  })
})

describe("applyTighten + idempotence", () => {
  const SOURCE = `const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
  { id: "A", observed: 5 },
  { id: "B", observed: 3 },
  { id: "C", observed: 0 },
]
`

  test("rewrites only the tightened rows; others unchanged", () => {
    const t = findBaselineTable(SOURCE)
    const plan = planTighten((t as NonNullable<typeof t>).rows, [
      { id: "A", observed: 2 },
      { id: "B", observed: 3 },
    ])
    const next = applyTighten(SOURCE, (t as NonNullable<typeof t>).rows, plan)
    expect(next).toContain('{ id: "A", observed: 2 }')
    expect(next).toContain('{ id: "B", observed: 3 }') // unchanged
    expect(next).toContain('{ id: "C", observed: 0 }') // unchanged
    expect(next).not.toContain('{ id: "A", observed: 5 }')
  })

  test("idempotent on second pass against the same observed set", () => {
    const t1 = findBaselineTable(SOURCE)
    const plan1 = planTighten((t1 as NonNullable<typeof t1>).rows, [
      { id: "A", observed: 2 },
      { id: "B", observed: 1 },
      { id: "C", observed: 0 },
    ])
    const pass1 = applyTighten(SOURCE, (t1 as NonNullable<typeof t1>).rows, plan1)
    const t2 = findBaselineTable(pass1)
    const plan2 = planTighten((t2 as NonNullable<typeof t2>).rows, [
      { id: "A", observed: 2 },
      { id: "B", observed: 1 },
      { id: "C", observed: 0 },
    ])
    expect(plan2.tightened).toEqual([])
    const pass2 = applyTighten(pass1, (t2 as NonNullable<typeof t2>).rows, plan2)
    expect(pass2).toBe(pass1)
  })

  test("empty plan → source unchanged (reference-equal short-circuit)", () => {
    const t = findBaselineTable(SOURCE)
    const plan = planTighten((t as NonNullable<typeof t>).rows, [])
    expect(applyTighten(SOURCE, (t as NonNullable<typeof t>).rows, plan)).toBe(SOURCE)
  })
})
