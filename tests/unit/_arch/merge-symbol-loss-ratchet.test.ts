/**
 * Architecture ratchet — silent symbol deletion by a merge commit.
 *
 * THE INCIDENT: merge `9b21d2fd2` ("merge: reconcile parallel goal and
 * verification lanes") reconciled two goal lanes and took ONE side wholesale for
 * the objective domain, deleting `src/objective/budget-limits.ts`,
 * `resolveProductAutonomousTurnCap`, `autonomousAllowance`, `clampBudgetLimit`,
 * `PRODUCT_BUDGET_CEILING`, the `hard-cap-exhausted` rejection and two test
 * files. The merge-base LACKED those files and one parent ADDED them, so a plain
 * 3-way merge would have KEPT them. Nothing in the message says any of it went.
 *
 * WHY THIS FILE IS THE ENFORCEMENT POINT: this repo has no git hooks
 * (`.git/hooks` holds only `*.sample`; no husky, no lefthook) and CI has not run
 * since GH Actions billing was cut (`gh run list` → HTTP 404). `bun test` is the
 * only thing that actually executes, so a ratchet that lives anywhere else is
 * decoration.
 *
 * WHY IT IS NOT JUST "scan the repo and assert clean": a diff-based scanner that
 * finds nothing produces the exact same green as a scanner that is broken. That
 * failure shape is a confirmed recurring defect here, so every real-history
 * assertion below is paired with (a) a synthetic red-on-injection case that
 * proves the detector still NAMES a dropped symbol and (b) an anti-vacuity floor
 * that proves the scan actually opened files.
 */

import { describe, expect, test } from "bun:test"

import {
  createGitReadPort,
  ENFORCED_MERGE_WINDOW,
  extractExportedSymbols,
  formatMergeScan,
  type GitReadPort,
  GRANDFATHERED_MERGES,
  isExcusedByMessage,
  isGrandfathered,
  isScannedPath,
  type MergeScan,
  scanMerge,
  scanMergeWindow,
} from "../../../tools/dev/merge-symbol-loss"

// ---------------------------------------------------------------------------
// A synthetic repository. Two parents, one merge, contents we choose.
// ---------------------------------------------------------------------------

interface FakeCommit {
  readonly parents: readonly string[]
  readonly message: string
  readonly files: Readonly<Record<string, string>>
}

const fakePort = (commits: Readonly<Record<string, FakeCommit>>): GitReadPort => {
  const at = (sha: string): FakeCommit => {
    const c = commits[sha]
    if (c === undefined) throw new Error(`fake port: unknown sha ${sha}`)
    return c
  }
  return {
    parents: (sha) => at(sha).parents,
    message: (sha) => at(sha).message,
    changedFiles: (from, to) => {
      const a = at(from).files
      const b = at(to).files
      const paths = new Set([...Object.keys(a), ...Object.keys(b)])
      return [...paths].filter((p) => a[p] !== b[p]).sort()
    },
    readFiles: (sha, paths) => new Map(paths.map((p) => [p, at(sha).files[p] ?? null])),
    listMerges: () => Object.keys(commits).filter((sha) => at(sha).parents.length >= 2),
  }
}

/** Shared history both lanes inherit from the merge-base. */
const LANE_SHARED = `
export const keepMe = (): number => 1
export interface KeptShape { readonly a: number }
`
/** Lane A's own edit to the shared file. */
const LANE_A_FILE = `${LANE_SHARED}
export const laneAOnly = 1
`
/** Lane B's own edit to the SAME file — this is what makes it a real 3-way merge. */
const LANE_B_FILE = `${LANE_SHARED}
export const laneBOnly = 2
`
/** The union a correct merge produces for the shared file. */
const MERGED_FILE = `${LANE_SHARED}
export const laneAOnly = 1
export const laneBOnly = 2
`
/** The enforcement half lane B ADDED and the merge must not silently drop. */
const LANE_B_NEW_FILE = `
export const clampBudgetLimit = (n: number): number => n
export const PRODUCT_BUDGET_CEILING = 1000
export type BudgetLimitSource = "product" | "user"
`

const LANE_PATH = "src/objective/lane.ts"
const BUDGET_PATH = "src/objective/budget-limits.ts"

/**
 * A synthetic two-lane merge. `mergeFiles` is the merge's tree — the ONLY thing
 * that varies between the injection case and its paired control.
 */
const syntheticCommits = (mergeMessage: string, mergeFiles: Readonly<Record<string, string>>) => ({
  BASE: { parents: [], message: "base", files: { [LANE_PATH]: LANE_SHARED } },
  P1: { parents: ["BASE"], message: "lane a", files: { [LANE_PATH]: LANE_A_FILE } },
  P2: {
    parents: ["BASE"],
    message: "lane b",
    files: { [LANE_PATH]: LANE_B_FILE, [BUDGET_PATH]: LANE_B_NEW_FILE },
  },
  M: { parents: ["P1", "P2"], message: mergeMessage, files: mergeFiles },
})

// ---------------------------------------------------------------------------
// RED-ON-INJECTION — the load-bearing test. If the detector is hollowed out,
// this is what goes red.
// ---------------------------------------------------------------------------

describe("merge symbol-loss detector — red on injection", () => {
  test("a merge that takes one lane wholesale is CAUGHT and the lost symbols are NAMED", () => {
    // Exactly the 9b21d2fd2 shape: P2 added an enforcement half, the merge kept
    // only P1's side, and the message says nothing about it.
    const port = fakePort(
      syntheticCommits("merge: reconcile parallel goal and verification lanes", {
        [LANE_PATH]: MERGED_FILE,
        // src/objective/budget-limits.ts silently gone
      }),
    )
    const scan = scanMerge("M", port)

    expect(scan.losses.length).toBeGreaterThan(0)
    const named = scan.losses.map((l) => l.symbol).sort()
    expect(named).toEqual(["BudgetLimitSource", "PRODUCT_BUDGET_CEILING", "clampBudgetLimit"])
    for (const loss of scan.losses) {
      expect(loss.file).toBe("src/objective/budget-limits.ts")
      expect(loss.parent).toBe("P2")
    }
    // The failure text a human would read must contain the actual name.
    expect(formatMergeScan(scan)).toContain("clampBudgetLimit")
    expect(formatMergeScan(scan)).toContain("src/objective/budget-limits.ts")
  })

  test("dropping ONE symbol out of a surviving file is caught (not just whole-file deletion)", () => {
    const port = fakePort(
      syntheticCommits("merge lanes", {
        [LANE_PATH]: MERGED_FILE,
        [BUDGET_PATH]: `
export const clampBudgetLimit = (n: number): number => n
export type BudgetLimitSource = "product" | "user"
`,
      }),
    )
    const scan = scanMerge("M", port)
    expect(scan.losses.map((l) => l.symbol)).toEqual(["PRODUCT_BUDGET_CEILING"])
  })

  test("PAIRED CONTROL (synthetic): the same merge keeping BOTH lanes scores 0", () => {
    // Same fixture, same parents, same file set — only the merge result differs.
    // Without this, the test above would also pass for a detector that flags
    // every merge.
    const port = fakePort(
      syntheticCommits("merge lanes", {
        [LANE_PATH]: MERGED_FILE,
        [BUDGET_PATH]: LANE_B_NEW_FILE,
      }),
    )
    const scan = scanMerge("M", port)
    expect(scan.losses).toEqual([])
    expect(scan.excused).toEqual([])
    expect(scan.filesExamined).toBeGreaterThan(0) // it really did look
  })

  test("a merge that only ADDS is not a loss", () => {
    const port = fakePort(
      syntheticCommits("merge lanes", {
        [LANE_PATH]: MERGED_FILE,
        [BUDGET_PATH]: `${LANE_B_NEW_FILE}\nexport const brandNew = 1\n`,
      }),
    )
    expect(scanMerge("M", port).losses).toEqual([])
  })

  test("a non-merge commit is out of scope and reports nothing examined", () => {
    const port = fakePort(syntheticCommits("m", {}))
    const scan = scanMerge("P1", port)
    expect(scan.losses).toEqual([])
    expect(scan.filesExamined).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The escape hatch
// ---------------------------------------------------------------------------

describe("merge symbol-loss detector — escape hatch", () => {
  const droppingMerge = (message: string) =>
    scanMerge("M", fakePort(syntheticCommits(message, { [LANE_PATH]: MERGED_FILE })))

  test("naming the dropped PATH in the commit message clears the merge", () => {
    const scan = droppingMerge(
      "merge: reconcile lanes\n\nDrops src/objective/budget-limits.ts — superseded by the user-budget cell.",
    )
    expect(scan.losses).toEqual([])
    expect(scan.excused.map((l) => l.symbol).sort()).toEqual([
      "BudgetLimitSource",
      "PRODUCT_BUDGET_CEILING",
      "clampBudgetLimit",
    ])
  })

  test("naming the dropped SYMBOLS clears exactly those, and no others", () => {
    const scan = droppingMerge(
      "merge: reconcile lanes\n\nRemoves clampBudgetLimit and PRODUCT_BUDGET_CEILING on purpose.",
    )
    expect(scan.excused.map((l) => l.symbol).sort()).toEqual([
      "PRODUCT_BUDGET_CEILING",
      "clampBudgetLimit",
    ])
    // BudgetLimitSource was NOT named, so it is still a live failure. A partial
    // confession does not clear the whole merge.
    expect(scan.losses.map((l) => l.symbol)).toEqual(["BudgetLimitSource"])
  })

  test("the hatch matches whole identifiers, not substrings", () => {
    const loss = { file: "src/a.ts", symbol: "cap", parent: "P" } as const
    expect(isExcusedByMessage("drop cap", loss)).toBe(true)
    expect(isExcusedByMessage("drop `cap`", loss)).toBe(true)
    // "capture"/"capability" must not silently excuse a symbol named `cap`.
    expect(isExcusedByMessage("feeder checkpoint capture", loss)).toBe(false)
    expect(isExcusedByMessage("capability literal ratchet", loss)).toBe(false)
  })

  test("the 9b21d2fd2 message would NOT have been cleared by the hatch", () => {
    // The whole point: the real merge said nothing, so the hatch cannot rescue it.
    expect(
      isExcusedByMessage("merge: reconcile parallel goal and verification lanes", {
        file: "src/objective/budget-limits.ts",
        symbol: "clampBudgetLimit",
        parent: "dbf519f97",
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Export extraction — the fact the whole signal rests on
// ---------------------------------------------------------------------------

describe("merge symbol-loss detector — export extraction", () => {
  test("every exported declaration form is picked up by name", () => {
    const names = extractExportedSymbols(`
      const notExported = 1
      export const a = 1
      export let b = 2
      export function c() {}
      export class D {}
      export interface E { x: number }
      export type F = string
      export enum G { X }
      export const { h, i: renamed } = { h: 1, i: 2 }
      const j = 1
      export { j }
      const k = 1
      export { k as l }
      export * as ns from "./x"
      export default function m() {}
    `)
    // `m` is deliberately ABSENT: a default export is named `default` whatever
    // form it takes, so `export default function m() {}` and `export default m`
    // expose the same thing, and converting between them is not a loss.
    expect([...names].sort()).toEqual([
      "D",
      "E",
      "F",
      "G",
      "a",
      "b",
      "c",
      "default",
      "h",
      "j",
      "l",
      "ns",
      "renamed",
    ])
    expect(names.has("notExported")).toBe(false)
    expect(names.has("k")).toBe(false) // renamed on the way out
  })

  test("scanned-path filter: source .ts only", () => {
    expect(isScannedPath("src/objective/budget-limits.ts")).toBe(true)
    expect(isScannedPath("src/objective/x.test.ts")).toBe(false)
    expect(isScannedPath("src/types/x.d.ts")).toBe(false)
    expect(isScannedPath("docs/notes.md")).toBe(false)
    expect(isScannedPath("package.json")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real history. Bounded window, explicit baseline.
// ---------------------------------------------------------------------------

describe("merge symbol-loss ratchet — real history", () => {
  const port = createGitReadPort()
  // Scanned ONCE. Every assertion below judges the very same scan the ratchet
  // judges — no second measurement path that could drift away from it.
  const window = scanMergeWindow(port, "HEAD", ENFORCED_MERGE_WINDOW)
  /**
   * A named reference merge. Reuses the window's own scan when the merge is
   * still inside it, and measures it directly once history has moved past it —
   * these references are fixed points of the PAST, so they must keep meaning
   * something as new merges push them out of the enforced window.
   */
  const referenceScan = (abbrev: string): MergeScan =>
    window.merges.find((m) => m.sha.startsWith(abbrev)) ?? scanMerge(abbrev, port)

  test("ANTI-VACUITY FLOOR: the scan really examined merges and files", () => {
    // Without this, an empty `git log` / a broken port reads as a clean repo.
    expect(window.merges.length).toBe(ENFORCED_MERGE_WINDOW)
    expect(window.filesExamined).toBeGreaterThan(100)
    for (const merge of window.merges) {
      expect(merge.parents.length).toBeGreaterThanOrEqual(2)
      expect(merge.subject.length).toBeGreaterThan(0)
    }
  })

  test("PAIRED CONTROL: the known-clean reference merges score exactly 0", () => {
    // Measured by hand and independently re-measured by an audit agent. If the
    // detector ever starts flagging these, the signal has drifted into noise and
    // the ratchet is worthless — that must go red, not be tuned away.
    for (const sha of ["79857f28b", "528f01ae5", "fc199ad3f"]) {
      const scan = referenceScan(sha)
      expect(`${sha}: ${scan.losses.map((l) => `${l.file}#${l.symbol}`).join(", ")}`).toBe(
        `${sha}: `,
      )
      expect(scan.filesExamined).toBeGreaterThan(0) // not clean-by-emptiness
    }
  })

  test("the recorded incident is STILL DETECTED (a baseline entry may not go quiet)", () => {
    // Grandfathering must never become invisibility. If someone weakens the
    // detector until 9b21d2fd2 scores 0, this is the test that notices.
    const scan = referenceScan("9b21d2fd2")
    expect(scan.losses.length).toBeGreaterThan(50)
    const lost = new Set(scan.losses.map((l) => l.symbol))
    for (const symbol of [
      "clampBudgetLimit",
      "PRODUCT_BUDGET_CEILING",
      "resolveProductAutonomousTurnCap",
      "autonomousAllowance",
    ]) {
      expect([...lost].includes(symbol)).toBe(true)
    }
    expect(scan.losses.some((l) => l.file === "src/objective/budget-limits.ts")).toBe(true)
    expect(isGrandfathered(scan.sha)).toBe(true)
  })

  test("every grandfathered entry carries a written reason", () => {
    expect(GRANDFATHERED_MERGES.size).toBeGreaterThan(0)
    for (const [sha, reason] of GRANDFATHERED_MERGES) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(reason.length).toBeGreaterThan(80)
    }
  })

  test("NO merge in the enforced window silently drops an exported symbol", () => {
    const offenders = window.merges
      .filter((m) => m.losses.length > 0 && !isGrandfathered(m.sha))
      .map((m) => formatMergeScan(m))
    expect(offenders.join("\n")).toBe("")
  })
})
