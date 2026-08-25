/**
 * HELLGATE — the verification scope must be DERIVED, not guessed.
 *
 * I landed main red three times in one session, and the post-mortem is that the
 * three had DIFFERENT causes, all invisible to "run the tests next to what you
 * touched":
 *
 *   1. `8ab5402b1` staged a test plus two files, but NOT the third source file
 *      that test needs. The working tree was green; the COMMIT was not. Cause:
 *      verified set ≠ staged set.
 *   2. `3afc9edaa` added an inline `instanceof Error ? … : String(…)` ternary.
 *      Its guard is a repo-wide SCANNER (`audit-ratchet/`) that imports nothing
 *      and reads every file, so no import graph can point at it.
 *   3. `82324412f` changed `src/agent/optional-ports.ts` and broke
 *      `src/host/runtime/__tests__/composition-slot-registry-…`, which mentions
 *      neither the file, its exports, nor its directory — measured: zero textual
 *      hits. It only reaches it TRANSITIVELY, through `assembleAgentConfig`.
 *
 * So the rule this pins is: scope = (tests that transitively import the changed
 * files) ∪ (the global scanners, which always run). Case 3 is the one that makes
 * the import graph load-bearing; case 2 is the one that makes the graph alone
 * insufficient.
 */

import { describe, expect, test } from "bun:test"
import { deriveVerificationScope } from "../../tools/dev/verify-scope"

describe("verify-scope — derived from the change, not from intuition", () => {
  test("H1 case 3: a transitive-only dependent is found (no textual mention exists)", () => {
    const scope = deriveVerificationScope(["src/agent/optional-ports.ts"])
    expect(scope.tests).toContain(
      "src/host/runtime/__tests__/composition-slot-registry-byte-identical.hellgate.test.ts",
    )
  })

  test("H2 case 2: global scanners are always in scope, whatever changed", () => {
    const scope = deriveVerificationScope(["src/apps/bench/resume/security.ts"])
    expect(scope.globals.some((g) => g.includes("audit-ratchet"))).toBe(true)
  })

  test("H3 a directly-importing test is found (the easy case still works)", () => {
    const scope = deriveVerificationScope(["src/tool/_shared/fresh-hash.ts"])
    expect(scope.tests.length).toBeGreaterThan(0)
  })

  test("H4 ANTI-VACUUM: the graph discriminates — a leaf change is a SMALL scope", () => {
    // The contract is NOT "always small". A change to a widely-imported module
    // really is visible to most of the suite, and saying so is the tool's job.
    // What must hold is that the answer is DERIVED and not a constant: a leaf
    // module has to come back far smaller than the suite, or the tool is just a
    // slower way of saying "run everything".
    const leaf = deriveVerificationScope(["src/apps/bench/remote/box-session/chunk-artifacts.ts"])
    expect(leaf.totalTestFiles).toBeGreaterThan(1000)
    expect(leaf.tests.length).toBeLessThan(leaf.totalTestFiles / 4)
  })

  test("H5 the scope is a strict SUBSET even for a central module", () => {
    // Barrel re-exports (`index.ts`) inflate reachability, so a core module can
    // reach most of the suite. It must still not reach ALL of it — a saturated
    // result would mean the resolver had started matching everything.
    const central = deriveVerificationScope(["src/storage/service.ts"])
    expect(central.tests.length).toBeLessThan(central.totalTestFiles)
  })

  test("H6 an unknown path derives NOTHING but still runs the scanners", () => {
    const scope = deriveVerificationScope(["src/does/not/exist.ts"])
    expect(scope.tests).toEqual([])
    expect(scope.globals.length).toBeGreaterThan(0)
  })
})
