/**
 * Ratchet — a NEW scanning guard must enroll its reach, not pick a number.
 *
 * ## What the existing gates do and do not demand
 *
 * `anti-vacuity-census` demands that a scan-derived zero-verdict carry SOME
 * floor, and it accepts an inline `toBeGreaterThanOrEqual(n)` for any n ≥ 2.
 * All three guards found vacuous on 2026-08-30 were fixed that way, and all
 * three fixes were WEAKER than they looked:
 *
 *   - 60 of 68 per-knob modules — eight could vanish silently
 *   - 20 of 22 system skills   — two whole skills could vanish silently
 *   - 7,804 of 8,776 tracked   — a 186-file subtree could vanish silently,
 *                                measured, while the count still cleared
 *
 * A count cannot see a SUBTREE disappear; it sees a smaller number, and the
 * margin the author left is exactly how much of the tree may go missing without
 * anyone noticing. `tools/dev/scan-reach-baseline.ts` says the same thing about
 * the numbers themselves: they are author-chosen, and the equilibrium they reach
 * in this repo is `1` — 56 of the 81 already written are `> 0`.
 *
 * The empty-mirror oracle does not close this either. It blanks a corpus root
 * ENTIRELY, so a red there proves the guard notices total loss, never partial.
 *
 * ## What this ratchet demands
 *
 * `assertScanPopulation`, whose floor lives in the committed baseline at the
 * MEASURED reach and which additionally asserts recursive coverage — every
 * directory holding a tracked collectable file contributed one. That is the
 * claim a count cannot make.
 *
 * ONE-DIRECTIONAL. The guards that predate this are listed in
 * `tools/dev/scan-enrollment-debt.json`, the shape `lint-debt-ceiling.json` and
 * `god-code/allowlist.json` already use here. The list may only shrink: a file
 * that enrolled and stayed listed fails, so the number cannot quietly stall.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { isScanVerdictGuard, scanVerdictGuards } from "@/../tools/dev/anti-vacuity-census"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DEBT = join(REPO_ROOT, "tools", "dev", "scan-enrollment-debt.json")

const debtList = (): readonly string[] =>
  (JSON.parse(readFileSync(DEBT, "utf8")) as { unenrolled?: readonly string[] }).unenrolled ?? []

const isEnrolled = (rel: string): boolean =>
  readFileSync(join(REPO_ROOT, rel), "utf8").includes("assertScanPopulation")

describe("scan enrollment", () => {
  test("anti-vacuity: the population is real and the debt list is a subset of it", () => {
    // Both directions matter. A population that came back empty would make the
    // ratchet below pass over nothing, and a debt entry naming a file that is not
    // in the population is a permission for something the rule never covered.
    const population = scanVerdictGuards()
    expect(population.length, "the census found no scan-verdict guards at all").toBeGreaterThan(50)
    const known = new Set(population)
    const strays = debtList().filter((f) => !known.has(f))
    expect(
      strays,
      `these are listed as enrollment debt but are not scan-verdict guards — ` +
        `remove them:\n  ${strays.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 no NEW scanning guard states a verdict without an enrolled reach", () => {
    const owed = new Set(debtList())
    const added = scanVerdictGuards()
      .filter((f) => !owed.has(f))
      .filter((f) => !isEnrolled(f))
    expect(
      added,
      added.length === 0
        ? ""
        : "these scan the repo and state a zero-verdict, but their floor is a number written " +
            "at the call site — which cannot see a subtree disappear. Call " +
            "`assertScanPopulation` from tests/unit/_shared/scan-population.ts and pin the " +
            "MEASURED reach in tools/dev/scan-reach-baseline.json:\n  " +
            added.join("\n  "),
    ).toEqual([])
  })

  test("the debt list has no stale entries — an enrolled guard must be removed from it", () => {
    // One-directional the other way, so the number cannot stall while the work is
    // already done. A file that enrolled and stayed listed would silently re-admit
    // itself if the enrollment were later deleted.
    const stale = debtList()
      .filter((f) => isEnrolled(f))
      .sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : "these now call assertScanPopulation — remove them from " +
            `tools/dev/scan-enrollment-debt.json so the list can only shrink:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 the rule fires on the shape that produced all three defects", () => {
    // Red-on-injection against the predicate itself: an inline count floor beside
    // a scan is exactly what the census accepts and what this ratchet must not.
    const fsCall = `read${"dir"}Sync`
    const guard =
      `import { ${fsCall} } from "node:fs"\n` +
      `test("x", () => {\n  const seen = ${fsCall}("s${"rc"}")\n` +
      `  expect(seen.length).toBeGreaterThanOrEqual(60)\n` +
      `  expect(seen.filter((f) => f.endsWith(".zzz"))).toEqual([])\n})\n`
    expect(isScanVerdictGuard(guard), "the population predicate missed the shape").toBe(true)
    expect(guard.includes("assertScanPopulation"), "the fixture must NOT be enrolled").toBe(false)
  })
})
