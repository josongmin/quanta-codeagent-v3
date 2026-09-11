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
 * # Three arms, because two of them are not enough
 *
 * The DECISION arm tests the predicate. The EFFECT arm applies it to a real
 * temp worker HOME and checks whether a `Library` entry actually appears —
 * necessary because a call that passes `resourceClass` in FORM while computing
 * it wrongly reads identically to a correct one. The WIRING arm reads the runner
 * and asserts it delegates rather than holding its own copy of the symlink, with
 * an anti-vacuity floor so a rename fails loudly instead of matching nothing.
 *
 * Every temp root is owner-scoped and removed in `afterAll`; this file leaves no
 * /tmp residue.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TEST_RESOURCE_CLASSES } from "../../../tools/dev/test-shard-plan"
import { applyUserLibraryDecision, userLibraryDecision } from "../../../tools/dev/worker-home"

/** Owner-scoped: every temp root this file creates is removed here, so the
 *  suite leaves no /tmp residue behind it. */
const made: string[] = []
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

  test("EFFECT — a Library link appears for the browser class and for nothing else", () => {
    // The source arm below is necessary but not sufficient: a call that passes
    // `resourceClass` in FORM while computing it wrongly reads identically. This
    // one checks the only thing that matters — whether the link is really there.
    const source = mkdtempSync(join(tmpdir(), "quanta-fake-library-"))
    made.push(source)
    writeFileSync(join(source, "marker.txt"), "real user library stand-in\n")

    const observed: Record<string, boolean> = {}
    for (const resourceClass of TEST_RESOURCE_CLASSES) {
      const workerHome = mkdtempSync(join(tmpdir(), "quanta-worker-home-"))
      made.push(workerHome)
      applyUserLibraryDecision({ workerHome, resourceClass, env: {}, sourceLibrary: source })
      observed[resourceClass] = existsSync(join(workerHome, "Library"))
    }
    const linked = Object.entries(observed)
      .filter(([, present]) => present)
      .map(([name]) => name)
    expect(linked).toEqual(["browser"])

    // ANTI-VACUITY: the fixture must be capable of producing a link at all, or
    // "only browser" is a statement about a mechanism that never fires.
    expect(observed.browser).toBe(true)
    expect(TEST_RESOURCE_CLASSES.length).toBeGreaterThanOrEqual(8)
  })

  test("EFFECT — the kill switch really prevents the link", () => {
    const source = mkdtempSync(join(tmpdir(), "quanta-fake-library-"))
    made.push(source)
    writeFileSync(join(source, "marker.txt"), "real user library stand-in\n")
    const workerHome = mkdtempSync(join(tmpdir(), "quanta-worker-home-"))
    made.push(workerHome)
    const outcome = applyUserLibraryDecision({
      workerHome,
      resourceClass: "browser",
      env: { QUANTA_TEST_NO_USER_LIBRARY: "1" },
      sourceLibrary: source,
    })
    expect(outcome).toBe("opted-out")
    expect(existsSync(join(workerHome, "Library"))).toBe(false)
  })

  test("WIRING — the runner delegates and does not re-implement the link", () => {
    const source = readFileSync(RUNNER, "utf8")

    // ANTI-VACUITY first: if the marker is renamed, fail here rather than let a
    // `not.toContain` pass over a file that no longer says anything.
    expect(source).toContain("lendRealUserLibrary")
    expect(source).toContain("applyUserLibraryDecision(")

    // The runner must not hold its own copy of the effect. It did: a
    // `symlinkSync(join(homedir(), "Library"), …)` inline, which is why the
    // policy could only ever be checked by reading the source.
    expect(source).not.toContain("symlinkSync")
    expect(source).not.toContain("homedir()")

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
