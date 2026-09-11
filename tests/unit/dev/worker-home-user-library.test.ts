/**
 * SAFETY GUARD — a shard worker's scratch HOME must not reach the developer's
 * real `~/Library` unless it is the browser lane.
 *
 * # What was measured at HEAD 85a99bb6f
 *
 * `run-test-shards.ts` called `lendRealUserLibrary(workerHome)` unconditionally,
 * once per worker. Over the tracked test corpus (3,957 files) the resource
 * classifier produces:
 *
 *     pure 3034 | integration-path 561 | lsp 210 | port 64
 *     process-global 56 | worktree 18 | browser 12 | repo-write 2
 *
 * Twelve `browser` files, of which only three drive a real Chrome
 * (`browser-agent-loop-e2e`, `browser-real-chrome-e2e`,
 * `browser-real-chrome-adversarial-e2e`) — the rest match the detector on a
 * string literal. A full plan is 44 chunks, so nearly every worker received a
 * symlink to the user's whole Library (Mail, Keychains, Safari, Messages, every
 * app's Application Support) for a browser it never starts.
 *
 * The Chrome measurement behind the workaround is real and is NOT being
 * discarded: a raw CDP probe completed `Page.navigate` 2/6 under a cold HOME and
 * 6/6 with the Library lent in. It is scoped to the lane that has a Chrome, and
 * `QUANTA_TEST_NO_USER_LIBRARY=1` removes it entirely.
 *
 * # Why the source arm is here too
 *
 * The decision function alone cannot prove the runner USES it — a correct policy
 * module beside an unconditional call site is exactly the shape the defect had.
 * The second arm reads the runner and asserts the call is class-aware, with an
 * anti-vacuity floor so a rename fails loudly instead of matching nothing.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { TEST_RESOURCE_CLASSES } from "../../../tools/dev/test-shard-plan"
import { userLibraryDecision } from "../../../tools/dev/worker-home"

const RUNNER = join(import.meta.dir, "..", "..", "..", "tools", "dev", "run-test-shards.ts")

describe("worker HOME: real ~/Library exposure", () => {
  test("only the browser class may reach the user's Library", () => {
    const lending = TEST_RESOURCE_CLASSES.filter(
      (resourceClass) => userLibraryDecision(resourceClass, {}) === "lend",
    )
    expect(lending).toEqual(["browser"])

    // ANTI-VACUITY: the corpus of classes must be real, so an emptied enum
    // cannot satisfy the equality above by having nothing to filter.
    expect(TEST_RESOURCE_CLASSES.length).toBeGreaterThanOrEqual(8)
    expect(TEST_RESOURCE_CLASSES).toContain("pure")
    expect(TEST_RESOURCE_CLASSES).toContain("browser")
  })

  test("every non-browser class is refused by name", () => {
    for (const resourceClass of TEST_RESOURCE_CLASSES) {
      if (resourceClass === "browser") continue
      expect({ resourceClass, decision: userLibraryDecision(resourceClass, {}) }).toEqual({
        resourceClass,
        decision: "not-browser",
      })
    }
  })

  test("the kill switch removes it from the browser lane too", () => {
    expect(userLibraryDecision("browser", { QUANTA_TEST_NO_USER_LIBRARY: "1" })).toBe("opted-out")
    // Only the exact opt-in value disables it: a stray empty string or a typo
    // must not silently turn the browser workaround off and re-introduce the
    // 1-in-3 navigate as an unexplained flake.
    expect(userLibraryDecision("browser", { QUANTA_TEST_NO_USER_LIBRARY: "" })).toBe("lend")
    expect(userLibraryDecision("browser", { QUANTA_TEST_NO_USER_LIBRARY: "true" })).toBe("lend")
  })

  test("the runner's call site is class-aware, not unconditional", () => {
    const source = readFileSync(RUNNER, "utf8")

    // ANTI-VACUITY first: if either marker is renamed, fail here rather than
    // let a `not.toContain` pass over a file that no longer says anything.
    expect(source).toContain("lendRealUserLibrary")
    expect(source).toContain("userLibraryDecision")

    const callSites = [...source.matchAll(/lendRealUserLibrary\(([^)]*)\)/gu)]
      .map((match) => (match[1] ?? "").trim())
      .filter((args) => args !== "")
    expect(callSites.length).toBeGreaterThan(0)
    for (const args of callSites) {
      expect({ args, classAware: args.includes("resourceClass") }).toEqual({
        args,
        classAware: true,
      })
    }
  })
})
