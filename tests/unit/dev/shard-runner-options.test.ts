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

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseShardRunnerOptions } from "../../../tools/dev/test-shard-options"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * Every case here parses options, and the parser reads
 * `QUANTA_VERIFICATION_TIER`. Inside a campaign that variable is SET — the gate
 * exports it — so a case naming its own `--tier` passed standalone and failed
 * under prepush with "contradicts QUANTA_VERIFICATION_TIER". The assertion was
 * right and the test was ambient.
 *
 * Applied file-wide rather than per case: a test that reads the environment and
 * does not control it is testing the box it happens to run on.
 */
const ORIGINAL_TIER = process.env.QUANTA_VERIFICATION_TIER

beforeEach(() => {
  delete process.env.QUANTA_VERIFICATION_TIER
})

afterEach(() => {
  if (ORIGINAL_TIER === undefined) delete process.env.QUANTA_VERIFICATION_TIER
  else process.env.QUANTA_VERIFICATION_TIER = ORIGINAL_TIER
})

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

  /**
   * The same sentence, one line down.
   *
   * "Refusing to pick one silently" was enforced between a FLAG and the ENV,
   * and last-one-wins between two flags on the same command line. MEASURED
   * before this: `--tier=pr --tier=nightly --discover-only` reported
   * `"name": "full:nightly"` over 3,965 files, and
   * `--suite=unit --suite=full` ran the full suite.
   */
  test("one option given twice is refused, whichever option it is", () => {
    const cases: readonly { readonly why: string; readonly argv: readonly string[] }[] = [
      { why: "two tiers", argv: ["--suite=full", "--tier=pr", "--tier=nightly"] },
      { why: "two suites", argv: ["--suite=unit", "--suite=full", "--tier=pr"] },
      { why: "two cache modes", argv: ["--tier=pr", "--cache=off", "--cache=read-write"] },
      {
        why: "two junit paths",
        argv: ["--suite=unit", "--tier=pr", "--junit-out=.cache/a.xml", "--junit-out=.cache/b.xml"],
      },
      // An identical repeat is refused too. It is unambiguous, but a wrapper
      // that appends an option it was already given is the shape that produced
      // the conflicting case, and "the second one was the same" is not a
      // property the parser should have to reason about.
      { why: "the same tier twice", argv: ["--suite=full", "--tier=pr", "--tier=pr"] },
    ]
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const { why, argv } of cases) {
      expect(() => parseShardRunnerOptions(argv), why).toThrow(/given twice/)
    }

    // PAIRED CONTROL: every one of those options, once each, still parses — so
    // the arm above is not satisfied by a parser that refuses everything.
    const parsed = parseShardRunnerOptions([
      "--suite=unit",
      "--tier=pr",
      "--cache=off",
      "--junit-out=.cache/unit-junit.xml",
    ])
    expect({
      suite: parsed.suite,
      tier: parsed.tier,
      cacheMode: parsed.cacheMode,
      junitOut: parsed.junitOut,
    }).toEqual({
      suite: "unit",
      tier: "pr",
      cacheMode: "off",
      junitOut: ".cache/unit-junit.xml",
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
