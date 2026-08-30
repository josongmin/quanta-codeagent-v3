import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

import { assertScanPopulation } from "./_shared/scan-population"

const REPAIR_DIR = join(import.meta.dir, "../../src/runner/batch/eval/repair")

describe("repair owner surface has no stale JS shadows", () => {
  test("every TypeScript owner file stays single-source (no sibling .js shadow)", () => {
    const names = readdirSync(REPAIR_DIR)
    const tsBases = new Set(
      names.filter((name) => name.endsWith(".ts")).map((name) => name.slice(0, -3)),
    )
    const jsShadows = names
      .filter((name) => name.endsWith(".js"))
      .filter((name) => tsBases.has(name.slice(0, -3)))
      .sort()
    // Anti-vacuity: the directory existing but being EMPTY yields the same green
    // as a clean one — proven, this file passes 1/0 against an empty mirror of
    // the repo's directory skeleton. A shadow ban over zero owners bans nothing.
    //
    // The floor was `tsBases.size > 3` against 14 real owners: a number this
    // author picked, on a DERIVED subset, tolerating ten files disappearing. The
    // helper goes on the RAW listing instead — that is what the ban consumes —
    // with the reach pinned at the measured value in the committed baseline.
    // `topLevelOnly` because the directory is flat and the read does not recurse;
    // the claim then becomes "every tracked file sitting directly here was
    // enumerated", which a count cannot make.
    //
    // `collectable` accepts every name, matching the unfiltered `readdirSync`. A
    // `.ts`-only predicate would stop demanding the very `.js` sibling this ban
    // exists to catch, which is the filter-mismatch the helper warns about.
    assertScanPopulation(
      names.map((name) => join(REPAIR_DIR, name)),
      REPAIR_DIR,
      {
        id: "tests/unit/repair-shadow-js-ratchet.test.ts#REPAIR-DIR",
        collectable: () => true,
        topLevelOnly: true,
      },
    )
    expect(jsShadows).toEqual([])
  })
})
