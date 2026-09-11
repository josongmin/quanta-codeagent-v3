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
import { join, resolve } from "node:path"
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

/**
 * TVH item 7 — a command that did not name a tier ran the whole universe.
 *
 * `tier === undefined` fell through to the entire discovered population.
 * MEASURED on this tree: `--suite=full` with no tier selects 3,965 files where
 * `--tier=full` selects 3,951. So `bun test` and a hand-run `test:full:ci` were
 * executing the NIGHTLY population by omission — and which population a command
 * ran depended on whether an ambient `QUANTA_VERIFICATION_TIER` happened to be
 * set by whoever invoked it. The same command string, two meanings, and no
 * receipt anywhere recorded which.
 */
describe("the tier is stated, never assumed", () => {
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env.QUANTA_VERIFICATION_TIER
    if (value === undefined) delete process.env.QUANTA_VERIFICATION_TIER
    else process.env.QUANTA_VERIFICATION_TIER = value
    try {
      return run()
    } finally {
      if (previous === undefined) delete process.env.QUANTA_VERIFICATION_TIER
      else process.env.QUANTA_VERIFICATION_TIER = previous
    }
  }

  test("no tier anywhere is REFUSED, and the message says what to pass", () => {
    withEnv(undefined, () => {
      expect(() => parseShardRunnerOptions(["--suite=full"])).toThrow(/--tier is required/)
      expect(() => parseShardRunnerOptions(["--suite=full"])).toThrow(/prepush\|pr\|full\|nightly/)
    })
  })

  test("a flag alone is enough, and an env alone is enough", () => {
    // ANTI-VACUITY: "always throw" would satisfy the arm above.
    withEnv(undefined, () => {
      expect(parseShardRunnerOptions(["--suite=full", "--tier=full"]).tier).toBe("full")
    })
    withEnv("prepush", () => {
      expect(parseShardRunnerOptions(["--suite=full"]).tier).toBe("prepush")
    })
  })

  test("a flag and an env that AGREE are fine", () => {
    withEnv("full", () => {
      expect(parseShardRunnerOptions(["--suite=full", "--tier=full"]).tier).toBe("full")
    })
  })

  test("a flag and an env that DISAGREE fail closed", () => {
    // The caller believes one population and the gate arranged another.
    // Silently picking either is how a command string comes to mean two runs.
    withEnv("prepush", () => {
      expect(() => parseShardRunnerOptions(["--suite=full", "--tier=nightly"])).toThrow(
        /contradicts QUANTA_VERIFICATION_TIER/,
      )
    })
  })

  test("every package alias that invokes the runner names a tier", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> }
    const invokers = Object.entries(pkg.scripts).filter(([, body]) =>
      body.includes("run-test-shards.ts"),
    )
    // ANTI-VACUITY: the scan must find the aliases at all.
    expect(invokers.length).toBeGreaterThanOrEqual(5)
    const untiered = invokers.filter(([, body]) => !body.includes("--tier=")).map(([name]) => name)
    // `test:full:ci` is the GATE's command: the gate supplies the tier through
    // the environment, because it runs at several tiers. Run by hand it now
    // fails closed, which is the intended outcome and not an exemption.
    expect(untiered).toEqual(["test:full:ci"])
  })
})
