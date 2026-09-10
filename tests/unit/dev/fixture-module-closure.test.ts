import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

/**
 * DRIFT GUARD — a fixture that materializes tools/dev modules into a scratch
 * repo must copy their whole import closure.
 *
 * Twice now a new module was added under `tools/dev/`, imported by one that
 * the behavioural fixtures copy, and the fixtures were not updated — so
 * `gate-receipt` and `verification-campaign` went from green to 0-pass with a
 * module-resolution error, and the first time it also left `main` briefly
 * broken because a committed file imported an untracked one. Both times the
 * failure surfaced only when those suites happened to be run.
 *
 * This closes the loop statically: for every module a fixture copies, every
 * relative import it makes must ALSO be in that fixture's copy list.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const TOOLS_DEV = join(REPO_ROOT, "tools", "dev")

/** Fixtures that stand a runnable copy of the rail up in a temp directory. */
const FIXTURES: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "tests/unit/dev/gate-receipt.test.ts",
    why: "runs gate.ts against a synthetic manifest in a scratch git repo",
  },
  {
    file: "tests/unit/dev/verification-campaign.test.ts",
    why: "runs the campaign wrapper against a scratch git repo",
  },
]

/** `"foo.ts"` string literals — the shape both fixtures use to list modules. */
const COPIED_MODULE = /"([a-z0-9-]+\.ts)"/g
const RELATIVE_IMPORT = /from\s+"\.\/([a-z0-9-]+)"/g

const DISCOVERED_FIXTURE_COPIERS = (() => {
  const dir = join(REPO_ROOT, "tests/unit/dev")
  const copyCall = "copyFile" + "Sync("
  const destJoin = "join(root, " + '"tools", "dev"'
  const testFiles = readdirSync(dir).filter((name) => name.endsWith(".test.ts"))
  const copiers = testFiles
    .filter((name) => {
      const text = readFileSync(join(dir, name), "utf8")
      return text.includes(copyCall) && text.includes(destJoin)
    })
    .map((name) => `tests/unit/dev/${name}`)
    .sort()
  assertScanPopulation(
    testFiles.map((name) => join(dir, name)),
    dir,
    {
      id: "tests/unit/dev/fixture-module-closure.test.ts#UNIT-DEV-COPIERS",
      collectable: (name) => name.endsWith(".test.ts"),
      topLevelOnly: true,
      matched: copiers.map((path) => join(REPO_ROOT, path)),
    },
  )
  return copiers
})()

const copiedModules = (fixtureSource: string): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const match of fixtureSource.matchAll(COPIED_MODULE)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

/** Transitive closure of `./x` imports, starting from what the fixture copies. */
const importClosure = (roots: Iterable<string>): ReadonlySet<string> => {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const module = queue.pop()
    if (module === undefined || seen.has(module)) continue
    seen.add(module)
    let source: string
    try {
      source = readFileSync(join(TOOLS_DEV, module), "utf8")
    } catch {
      // Not a tools/dev module (the fixture also names its own outputs).
      continue
    }
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const dependency = `${match[1]}.ts`
      if (!seen.has(dependency)) queue.push(dependency)
    }
  }
  return seen
}

describe("fixtures copy the whole import closure they run", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.file} — ${fixture.why}`, () => {
      const source = readFileSync(join(REPO_ROOT, fixture.file), "utf8")
      const copied = copiedModules(source)
      // ANTI-VACUITY: a fixture that copies nothing must fail here, not pass
      // by having an empty closure to satisfy.
      expect(copied.size).toBeGreaterThanOrEqual(3)

      const required = importClosure(copied)
      const missing = [...required]
        .filter((module) => !copied.has(module))
        // A module the fixture GENERATES rather than copies is not missing.
        .filter((module) => !source.includes(`join(root, "tools", "dev", "${module}")`))
        .sort()

      expect(
        missing,
        missing.length === 0
          ? ""
          : `${fixture.file} copies modules that import these, but does not copy them — the ` +
              `scratch repo cannot resolve them and the suite dies before asserting anything: ` +
              missing.join(", "),
      ).toEqual([])
    })
  }

  test("FIXTURES is the closed universe of scratch-rail copiers under tests/unit/dev", () => {
    expect(DISCOVERED_FIXTURE_COPIERS.length).toBeGreaterThan(0)
    expect([...FIXTURES.map((row) => row.file)].sort()).toEqual(DISCOVERED_FIXTURE_COPIERS)
  })
})
