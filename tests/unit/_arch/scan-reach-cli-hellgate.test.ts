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
  AUTHORITATIVE_SCAN_TIERS,
  scanReachAuthorityProblem,
  scanReachMembershipSha256,
  testPolicySha256,
} from "@/../tools/dev/scan-reach-authority"
import {
  currentScanReachAuthority,
  decide,
  observedFromReceipt,
  type ScanReach,
  type ScanReachBaseline,
  type ScanReachReceipt,
  scanReachChildArgs,
} from "@/../tools/dev/scan-reach-baseline"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const baselineOf = (scans: Record<string, ScanReach>): ScanReachBaseline => ({
  note: "fixture",
  scans,
})

/**
 * The authority a receipt has to match. Fixture values, because these tests are
 * about the COMPARISON; the real one is recomputed from the tree by
 * `currentScanReachAuthority`, which the wiring test below pins.
 */
const AUTHORITY = {
  suite: "full",
  tier: "full",
  membershipSha256: "1".repeat(64),
  policySha256: "2".repeat(64),
  capabilitySha256: "3".repeat(64),
} as const

const CLEAN = { head: "abc", status: "" } as const

const receiptFor = (overrides: Partial<ScanReachReceipt> = {}): ScanReachReceipt => ({
  schema: "quanta.scan-reach-receipt.v2",
  head: "abc",
  manifestSha256: "a".repeat(64),
  childExit: 0,
  records: [{ id: "f#one", walked: 10 }],
  ...AUTHORITY,
  ...overrides,
})

describe("scan-reach CLI decision", () => {
  test("exact-HEAD clean shard receipt replaces the dedicated child", () => {
    const observed = observedFromReceipt(
      receiptFor({
        records: [
          { id: "f#one", walked: 10 },
          { id: "f#one", walked: 8 },
        ],
      }),
      CLEAN,
      AUTHORITY,
    )
    expect(observed?.get("f#one")).toEqual({ walked: 8 })
  })

  test("stale, dirty, malformed, or failed shard receipts are never consumed", () => {
    const base = receiptFor()
    expect(observedFromReceipt(base, { head: "different", status: "" }, AUTHORITY)).toBeUndefined()
    expect(
      observedFromReceipt(base, { head: "abc", status: " M changed.ts" }, AUTHORITY),
    ).toBeUndefined()
    expect(
      observedFromReceipt(receiptFor({ manifestSha256: "short" }), CLEAN, AUTHORITY),
    ).toBeUndefined()
    expect(
      observedFromReceipt(receiptFor({ records: [{ id: "f#one", walked: -1 }] }), CLEAN, AUTHORITY),
    ).toBeUndefined()
  })

  /**
   * TVH P0-2. The predecessor checked `manifestSha256.length !== 64` — a
   * LENGTH. Any 64 hex characters passed and the digest named nothing. `suite`
   * was in the type and never compared, so a `unit` receipt stood in for the
   * full universe, and there was no `tier`, so `--suite=full --tier=pr` (3,938
   * of 3,962 files) minted a receipt the closed-universe consumer accepted.
   *
   * scan-reach is a FLOOR ratchet, so the consequence is not "slightly weaker
   * evidence": a receipt from a narrower population reports lower reach for ids
   * it never walked, which is read as a regression in the wrong place — or
   * accepted, letting a guard ship with a reach nobody measured.
   */
  describe("a receipt must describe the run the consumer needs", () => {
    const rejected = (overrides: Partial<ScanReachReceipt>): void => {
      expect(observedFromReceipt(receiptFor(overrides), CLEAN, AUTHORITY)).toBeUndefined()
    }

    test("a UNIT-suite receipt is not evidence for the full universe", () => {
      rejected({ suite: "unit" })
    })

    test("a PREPUSH-tier receipt is refused as a narrowed tier", () => {
      rejected({ tier: "prepush" })
      expect(scanReachAuthorityProblem(receiptFor({ tier: "prepush" }), AUTHORITY)).toBe(
        "non-authoritative-tier",
      )
    })

    test("a REDUCED full (--tier=pr) is not a full-universe proof", () => {
      rejected({ tier: "pr" })
      expect(scanReachAuthorityProblem(receiptFor({ tier: "pr" }), AUTHORITY)).toBe(
        "non-authoritative-tier",
      )
    })

    test("a receipt claiming `full` while carrying another population is RED", () => {
      // The tier label is authoritative and the membership still disagrees —
      // the case a tier check ALONE would wave through.
      rejected({ membershipSha256: "9".repeat(64) })
      expect(
        scanReachAuthorityProblem(receiptFor({ membershipSha256: "9".repeat(64) }), AUTHORITY),
      ).toBe("membership-mismatch")
    })

    test("a FAKE manifest digest no longer passes on its length", () => {
      // 64 valid hex characters, naming nothing. This is the exact shape the
      // length check accepted — caught now because the MEMBERSHIP is compared
      // against a recomputed one rather than being taken on trust.
      rejected({ membershipSha256: "abcdef0123456789".repeat(4) })

      // And the provenance digest is checked for SHAPE, not length: 64
      // characters that are not hex is not a sha256, and a survivor proved the
      // old `length !== 64` could not tell the difference.
      rejected({ manifestSha256: "z".repeat(64) })
      rejected({ manifestSha256: "A".repeat(64) })
      // ANTI-VACUITY: a real digest in the same field still passes.
      expect(
        observedFromReceipt(receiptFor({ manifestSha256: "0".repeat(64) }), CLEAN, AUTHORITY),
      ).toBeDefined()
    })

    test("an OLD tier policy is RED — the population rules moved", () => {
      rejected({ policySha256: "8".repeat(64) })
      expect(
        scanReachAuthorityProblem(receiptFor({ policySha256: "8".repeat(64) }), AUTHORITY),
      ).toBe("policy-mismatch")
    })

    test("a different host capability set is RED", () => {
      rejected({ capabilitySha256: "7".repeat(64) })
    })

    test("a v1 receipt cannot be read as a v2 proof", () => {
      rejected({ schema: "quanta.scan-reach-receipt.v1" as ScanReachReceipt["schema"] })
    })

    test("the CURRENT exact full receipt is the only thing that passes", () => {
      // ANTI-VACUITY: every arm above returns undefined, so the suite would be
      // satisfied by a consumer that rejects everything.
      const observed = observedFromReceipt(receiptFor(), CLEAN, AUTHORITY)
      expect(observed?.get("f#one")).toEqual({ walked: 10 })
      expect(scanReachAuthorityProblem(receiptFor(), AUTHORITY)).toBeUndefined()
    })
  })

  test("the consumer recomputes the authority from the tree, never from the receipt", () => {
    // A receipt that carries its own authority certifies itself. This is the
    // arm that keeps the comparison a check rather than an echo.
    const current = currentScanReachAuthority(REPO_ROOT)
    expect(current.suite).toBe("full")
    expect(current.tier).toBe("full")
    expect(current.membershipSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(current.policySha256).toBe(testPolicySha256(REPO_ROOT))
    // ...and it is a digest of the REAL population, not of an empty walk.
    expect(current.membershipSha256).not.toBe(scanReachMembershipSha256(REPO_ROOT, []))
    expect(AUTHORITATIVE_SCAN_TIERS).toEqual(["full", "nightly"])
  })

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
