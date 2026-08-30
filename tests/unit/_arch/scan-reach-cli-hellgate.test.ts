/**
 * Hellgate — `bun run scan-reach` may not report success over a red run.
 *
 * The CLI printed the child's exit code in its summary line and checked it
 * nowhere:
 *
 *   `scan-reach: 95 scans at or above their floors (test run exit ${run.exitCode})`
 *
 * Reach is RECORDED before an assertion fails — `assertScanPopulation` appends to
 * the sink and then asserts — so a suite that fails still produces a complete
 * harvest, every floor is met, and the gate exits 0. "The numbers matched" while
 * the tests those numbers came from were failing is this repo's recurring defect
 * one level up: a verdict whose failure and success produce the same value.
 *
 * `--tighten` was worse. It ran BEFORE the blocking checks, so it would pin
 * whatever a red run happened to reach, and `tighten()` only refuses over
 * regressions — never over an unpinned row, a stale row, or a failing child.
 *
 * The decision is now a pure function so a failing child is testable without a
 * fixture that pollutes the tree, and the case below drives it with a REAL
 * harvest from a REAL failing child rather than a hand-built map.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  decide,
  type ScanReach,
  type ScanReachBaseline,
  scanReachChildArgs,
} from "@/../tools/dev/scan-reach-baseline"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const baselineOf = (scans: Record<string, ScanReach>): ScanReachBaseline => ({
  note: "fixture",
  scans,
})

describe("scan-reach CLI decision", () => {
  test("harvest runs in one isolated worker — parallel test state cannot erase an observed scan", () => {
    expect(scanReachChildArgs(["one.test.ts", "two.test.ts"])).toEqual([
      "bun",
      "test",
      "--parallel=1",
      "--timeout=60000",
      "one.test.ts",
      "two.test.ts",
    ])
  })

  test("🔴 a FAILING child is refused even when every floor is met", () => {
    const observed = new Map([["a", { walked: 10 }]])
    const d = decide({
      childExit: 1,
      observed,
      baseline: baselineOf({ a: { walked: 10 } }),
      tighten: false,
    })
    expect(d.exit).toBe(1)
    expect(d.lines.join("\n")).toContain("FAILED")
  })

  test("PAIRED CONTROL — the same numbers with a green child pass", () => {
    // Without this, "refuse everything" would satisfy the case above, and that is
    // a different way of not knowing.
    const observed = new Map([["a", { walked: 10 }]])
    const d = decide({
      childExit: 0,
      observed,
      baseline: baselineOf({ a: { walked: 10 } }),
      tighten: false,
    })
    expect(d.exit).toBe(0)
    expect(d.doTighten).toBe(false)
  })

  test("🔴 --tighten refuses over a failing child, an unpinned row, and a stale row", () => {
    const cases: ReadonlyArray<readonly [string, Parameters<typeof decide>[0]]> = [
      [
        "failing child",
        {
          childExit: 1,
          observed: new Map([["a", { walked: 10 }]]),
          baseline: baselineOf({ a: { walked: 10 } }),
          tighten: true,
        },
      ],
      [
        "unpinned row",
        {
          childExit: 0,
          observed: new Map([["a", { walked: 10 }]]),
          baseline: baselineOf({}),
          tighten: true,
        },
      ],
      [
        "stale row",
        {
          childExit: 0,
          observed: new Map([["a", { walked: 10 }]]),
          baseline: baselineOf({ a: { walked: 10 }, gone: { walked: 3 } }),
          tighten: true,
        },
      ],
    ]
    for (const [name, input] of cases) {
      const d = decide(input)
      expect({ name, exit: d.exit, doTighten: d.doTighten }).toEqual({
        name,
        exit: 1,
        doTighten: false,
      })
    }
  })

  test("--tighten proceeds on a clean run", () => {
    const d = decide({
      childExit: 0,
      observed: new Map([["a", { walked: 12 }]]),
      baseline: baselineOf({ a: { walked: 10 } }),
      tighten: true,
    })
    expect({ exit: d.exit, doTighten: d.doTighten }).toEqual({ exit: 0, doTighten: true })
  })

  test("🔴 a file recorded as enrolled must REPORT every id it claims", () => {
    // Site-level completeness, checked against ground truth instead of syntax.
    // Counting enumerator calls cannot settle it: a recursive walker's internal
    // `readdirSync` is one site not one per level, and `no-leftover-backup-files`
    // reports THREE ids from a single call in a loop over three prefixes —
    // measured. What the guards actually report is the only reading that is
    // neither over- nor under-counting.
    const observed = new Map([["f#one", { walked: 10 }]])
    const baseline = baselineOf({ "f#one": { walked: 10 } })
    const d = decide({
      childExit: 0,
      observed,
      baseline,
      tighten: false,
      expectedIds: { "f.test.ts": ["f#one", "f#two"] },
    })
    expect(d.exit).toBe(1)
    expect(d.lines.join("\n")).toContain("f#two")
  })

  test("🔴 an id no ledger entry OWNS is refused", () => {
    // The other direction. Checking only "is every expected id observed" leaves a
    // reported scan that nobody records as owning it, which is a scan no file is
    // accountable for — exactly the state the ledger exists to prevent.
    const d = decide({
      childExit: 0,
      observed: new Map([
        ["f#one", { walked: 10 }],
        ["stranger#x", { walked: 3 }],
      ]),
      baseline: baselineOf({ "f#one": { walked: 10 }, "stranger#x": { walked: 3 } }),
      tighten: false,
      expectedIds: { "f.test.ts": ["f#one"] },
    })
    expect(d.exit).toBe(1)
    expect(d.lines.join("\n")).toContain("no file in scan-enrollment-debt.json owns")
  })

  test("🔴 a PINNED row no ledger entry claims is refused", () => {
    // And the third. A baseline row with no owner is a floor nobody maintains;
    // when the guard that produced it is deleted the row survives as coverage.
    const d = decide({
      childExit: 0,
      observed: new Map([["f#one", { walked: 10 }]]),
      baseline: baselineOf({ "f#one": { walked: 10 }, "orphan#y": { walked: 1 } }),
      tighten: false,
      expectedIds: { "f.test.ts": ["f#one"] },
    })
    expect(d.exit).toBe(1)
    expect(d.lines.join("\n")).toContain("no ledger entry claims it")
  })

  test("with NO ledger at all the two new directions stay quiet", () => {
    // The checks are scoped to a populated ledger on purpose: a caller that
    // passes no expectedIds is asking the older question, and answering a
    // question it did not ask would make every such run red for free.
    const d = decide({
      childExit: 0,
      observed: new Map([["f#one", { walked: 10 }]]),
      baseline: baselineOf({ "f#one": { walked: 10 } }),
      tighten: false,
    })
    expect(d.exit).toBe(0)
  })

  test("PAIRED CONTROL — a file reporting every id it claims passes", () => {
    const observed = new Map([
      ["f#one", { walked: 10 }],
      ["f#two", { walked: 4 }],
    ])
    const d = decide({
      childExit: 0,
      observed,
      baseline: baselineOf({ "f#one": { walked: 10 }, "f#two": { walked: 4 } }),
      tighten: false,
      expectedIds: { "f.test.ts": ["f#one", "f#two"] },
    })
    expect(d.exit).toBe(0)
  })

  test("an empty harvest is refused — the run IS the measurement", () => {
    const d = decide({
      childExit: 0,
      observed: new Map(),
      baseline: baselineOf({ a: { walked: 10 } }),
      tighten: true,
    })
    expect({ exit: d.exit, doTighten: d.doTighten }).toEqual({ exit: 1, doTighten: false })
  })

  test("🔴 END TO END — a real failing child still records a FULL harvest", () => {
    // The premise the whole hole rests on, measured rather than argued: the sink
    // is written before the assertion fails, so a red suite hands the CLI numbers
    // that meet every floor.
    const dir = mkdtempSync(join(tmpdir(), "scan-reach-cli-"))
    const sink = join(dir, "sink.jsonl")
    const fixtureBaseline = join(dir, "baseline.json")
    const fixture = join(REPO_ROOT, `zzz-scan-reach-probe-${process.pid}.test.ts`)
    try {
      const srcDir = join(REPO_ROOT, "src", "shared")
      writeFileSync(
        fixtureBaseline,
        JSON.stringify({ note: "fixture", scans: { "probe#SHARED": { walked: 1 } } }),
      )
      writeFileSync(
        fixture,
        [
          `import { test, expect } from "bun:test"`,
          `import { readdirSync } from "node:fs"`,
          `import { join } from "node:path"`,
          `import { assertScanPopulation } from "./tests/unit/_shared/scan-population"`,
          `test("records reach, then fails", () => {`,
          `  const root = ${JSON.stringify(srcDir)}`,
          `  const files = readdirSync(root).filter((f) => f.endsWith(".ts"))`,
          `  assertScanPopulation(files.map((f) => join(root, f)), root, {`,
          `    id: "probe#SHARED",`,
          `    collectable: (n) => n.endsWith(".ts"),`,
          `    topLevelOnly: true,`,
          `    baselinePath: ${JSON.stringify(fixtureBaseline)},`,
          `  })`,
          `  expect("the guard's real assertion").toBe("which fails")`,
          `})`,
          "",
        ].join("\n"),
      )
      const child = Bun.spawnSync(["bun", "test", fixture], {
        cwd: REPO_ROOT,
        env: { ...process.env, QUANTA_SCAN_REACH_RECORD: sink },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(child.exitCode, "the fixture was supposed to FAIL").not.toBe(0)

      const rows = readFileSync(sink, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { id: string; walked: number })
      expect(rows.length, "a red run recorded NO reach — the premise is wrong").toBeGreaterThan(0)

      const observed = new Map(rows.map((r) => [r.id, { walked: r.walked }]))
      const baseline = baselineOf(
        Object.fromEntries([...observed].map(([id, r]) => [id, { walked: r.walked }])),
      )
      // Every floor is met, by construction — and the run was red.
      expect(decide({ childExit: 0, observed, baseline, tighten: false }).exit).toBe(0)
      expect(decide({ childExit: child.exitCode, observed, baseline, tighten: false }).exit).toBe(1)
    } finally {
      rmSync(fixture, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
