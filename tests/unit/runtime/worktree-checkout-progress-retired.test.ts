/**
 * RESOLUTION-PLAN R5 — HONEST RETIREMENT of the dead RFC-04 D2 worktree
 * checkout-% chain.
 *
 * FACT (re-confirmed, incl. adversarial): `git worktree add` REJECTS `--progress`
 * (`error: unknown option 'progress'`) and shares the object store (no fetch /
 * no checkout meter on a piped stderr), so a real per-file checkout percentage is
 * STRUCTURALLY IMPOSSIBLE on the current path. The D2 chain that parsed and
 * surfaced such a percentage (`checkoutProgressObserver` + the git-progress
 * reader/parser + the `worktreeCheckoutProgress` node producer + the adapter's
 * `checkoutPercentage`/`checkout-progress` arm) therefore had ZERO production
 * callers — it was dead code fabricating a UX that git never feeds.
 *
 * This is the honesty INVARIANT rail: the checkout-% symbols must not exist in
 * production `src/` at all (a percentage source that cannot exist must not be
 * silently carried as dead code — `honesty over silent-dead-code`). RED before
 * the retirement (the symbols were live definitions), GREEN after.
 *
 * It also PINS the KEPT staged-progress adapter (`worktreeProgressToActivity` /
 * `makeWorktreeActivityObserver`) as an honest, explicitly UNWIRED forward seam:
 * it maps a runtime worktree-create progress union onto the D1 staged nodes, but
 * has NO production caller — the DELIVERED staged-card UX is emitted DIRECTLY by
 * `current-thread-worktree.ts` (`worktreeStepOpen`/`worktreeStepSettle`), not
 * through this adapter. The pin keeps that "no production caller" claim from
 * silently rotting into a live-but-undocumented second spine.
 *
 * Pure source-text scan over real bytes — no git, no I/O. A leaf unit.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO = join(import.meta.dir, "..", "..", "..")
const SRC = join(REPO, "src")

/** Every production `.ts` file under `src/` (test files excluded — a symbol may
 *  legitimately survive inside a test that documents the retirement). */
const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs))
      continue
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
    out.push(abs)
  }
  return out
}

const SRC_FILES: ReadonlyArray<{ readonly rel: string; readonly text: string }> = walk(SRC)
  .map((abs) => ({ rel: relative(REPO, abs), text: readFileSync(abs, "utf8") }))
  .sort((a, b) => a.rel.localeCompare(b.rel))

/** Production files (relative paths) that MENTION `token` anywhere. */
const filesMentioning = (token: string): string[] =>
  SRC_FILES.filter((f) => f.text.includes(token)).map((f) => f.rel)

/** The dead D2 checkout-% symbols. Each MUST be absent from production `src/`
 *  after the retirement (RED while any definition/reference/comment survives). */
const RETIRED_SYMBOLS = [
  "checkoutProgressObserver",
  "createCheckoutProgressReader",
  "parseCheckoutProgressLine",
  "CheckoutProgressReader",
  "worktreeCheckoutProgress",
  "checkoutPercentage",
] as const

describe("R5 honesty invariant — the dead D2 checkout-% symbols are GONE from src", () => {
  test("the git checkout-progress parser module no longer exists", () => {
    expect(existsSync(join(SRC, "runtime", "worktree-progress.ts"))).toBe(false)
  })

  for (const symbol of RETIRED_SYMBOLS) {
    test(`no production reference remains: ${symbol}`, () => {
      expect(filesMentioning(symbol)).toEqual([])
    })
  }

  test("the fabricated `meta.checkoutPercentage` UX hint is gone too", () => {
    // The producer stamped a `checkoutPercentage` meta key onto the checkout
    // node; with the % source impossible, no production code may emit it.
    expect(filesMentioning("checkoutPercentage")).toEqual([])
  })
})

/**
 * Non-vacuity floor: the scan must be LIVE over real bytes. If the walker breaks
 * (renamed dir, empty read) every `toEqual([])` above would pass VACUOUSLY. These
 * anchor the scan against symbols that genuinely DO survive, so a dead walker
 * fails loudly here.
 */
describe("R5 honesty invariant — the scan is non-vacuous (a dead walker FAILS)", () => {
  test("src walk reaches a large, real file set", () => {
    assertScanPopulation(
      SRC_FILES.map((file) => join(REPO, file.rel)),
      SRC,
      { id: "tests/unit/runtime/worktree-checkout-progress-retired.test.ts#SRC" },
    )
    expect(SRC_FILES.length).toBeGreaterThan(500)
  })

  test("KEPT live D1 owners are still found by the scan (floor)", () => {
    // These are the live staged-progress producers the retirement must NOT touch;
    // if the scan cannot see them, its emptiness proofs above are worthless.
    expect(filesMentioning("createPersistentWorktree").length).toBeGreaterThan(0)
    expect(filesMentioning("worktreeStepOpen").length).toBeGreaterThan(0)
    expect(filesMentioning("worktreeStepSettle").length).toBeGreaterThan(0)
  })
})

/**
 * Forward-seam pin: the runtime-progress → activity adapter is KEPT as an
 * explicitly UNWIRED seam. Its exported mapper/observer must have NO production
 * caller OUTSIDE its own definition file — the delivered staged UX comes from the
 * direct emit in `current-thread-worktree.ts`, not this adapter. This is the
 * "test pinning no production caller" that licenses keeping the forward contract.
 */
describe("R5 forward-seam pin — the staged adapter has NO production caller", () => {
  const ADAPTER = "src/runner/session-ops/worktree/activity-adapter.ts"

  test("the adapter module still exists (kept, not deleted)", () => {
    expect(existsSync(join(REPO, ADAPTER))).toBe(true)
  })

  for (const seam of ["worktreeProgressToActivity", "makeWorktreeActivityObserver"] as const) {
    test(`${seam} is referenced ONLY by its own definition file`, () => {
      expect(filesMentioning(seam)).toEqual([ADAPTER])
    })
  }
})
