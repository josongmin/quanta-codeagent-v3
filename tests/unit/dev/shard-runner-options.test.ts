/**
 * `--parallel=N` is a real `bun test` flag; it is NOT a shard-runner option.
 *
 * The runner's parser had `if (arg === "--parallel=1") continue` — a silent
 * no-op — while five package scripts passed `--parallel=1` to it:
 * `test`, `test:unit`, `test:unit:ci`, `test:integration`, `test:full:ci`.
 * `bun test --parallel=<N>` means "run test files in N worker processes, implies
 * --isolate", so each of those commands READ as serial-isolated and EXECUTED
 * with the runner's own intra-worker width, up to 8-wide for `pure` chunks.
 *
 * A no-op argument is worse than a refused one: it survives review, because the
 * reviewer reads the flag and believes it. This pins the refusal and pins that
 * no script hands the flag to this runner again.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parseShardRunnerOptions } from "../../../tools/dev/test-shard-options"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

describe("shard runner options", () => {
  test("--parallel is refused, not silently ignored", () => {
    for (const arg of ["--parallel=1", "--parallel=8", "--parallel"]) {
      expect(() => parseShardRunnerOptions(["--suite=full", arg])).toThrow(
        /not a shard-runner option/,
      )
    }
  })

  test("the options it does accept still parse", () => {
    const opts = parseShardRunnerOptions(["--suite=full", "--tier=pr", "--discover-only"])
    expect(opts.suite).toBe("full")
    expect(opts.tier).toBe("pr")
    expect(opts.discoverOnly).toBe(true)
  })

  test("an unknown option is refused rather than absorbed", () => {
    expect(() => parseShardRunnerOptions(["--suite=full", "--nonsense"])).toThrow(
      /unknown shard runner argument/,
    )
  })

  test("no package script hands --parallel to the shard runner", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>
    }
    const offenders = Object.entries(pkg.scripts)
      .filter(([, command]) => command.includes("run-test-shards.ts"))
      .filter(([, command]) => /--parallel(=|\s|$)/u.test(command))
      .map(([name]) => name)
    expect(offenders).toEqual([])

    // ANTI-VACUITY: the filter must actually have found shard-runner scripts,
    // or an empty offender list proves nothing. Five of them existed at the
    // commit this guard was written against.
    const shardScripts = Object.entries(pkg.scripts).filter(([, command]) =>
      command.includes("run-test-shards.ts"),
    )
    expect(shardScripts.length).toBeGreaterThanOrEqual(5)
  })
})
