import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

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
    expect(
      tsBases.size,
      "no TypeScript owners found in the repair surface — the shadow ban is vacuous",
    ).toBeGreaterThan(3)
    expect(jsShadows).toEqual([])
  })
})
