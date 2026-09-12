/**
 * ★ The capability receipt had FIFTEEN consumers and no producer.
 *
 * `tools/dev/capability-probe-producer.ts` was invoked by nothing — not
 * `package.json`, not `.github/workflows/`, not `gate-manifest.ts`, not the shard
 * runner — and nothing set `QUANTA_CAPABILITY_RECEIPT`. So every
 * `capability("<id>")` answered `blocked-missing`, `canExecute` turned that into
 * `describe.skip`, and the gated files reported PASS having executed nothing. On
 * every host. Since the artifact was introduced.
 *
 * The blast radius, counted STATICALLY, because a static count is the same on
 * every host and a pass count is not:
 *
 *   13 test files consume the receipt and gate on it
 *   17 `canExecute` invocations across them
 *    3 of the 13 also call `requireCapability` (the `tests/contract/` three)
 *
 * The numbers above were 15 and 33, and both were wrong. The bare grep counts
 * two files that are not consumers — one mentions `canExecute` in a COMMENT and
 * never imports the module, the other is the test OF the mechanism, whose own
 * assertions and docstring supplied fourteen of the matches. Recompute by
 * intersecting the two facts that make a consumer, not by matching a word:
 *
 *   comm -12 \
 *     <(grep -rln canExecute tests --include='*.ts' | grep -v _helpers/ | sort) \
 *     <(grep -rln 'from "[^"]*capability-receipt-consumer"' tests --include='*.ts' | sort) \
 *     | grep -v capability-receipt-wiring
 *
 * With no receipt every one of those 33 resolves `blocked-missing`, which the
 * lane turns into `describe.skip`, which Bun reports as a PASSING file. The
 * paired control below drives exactly that state.
 *
 * # Why there is no recovered-case total here
 *
 * An earlier version of this comment claimed "thirty-three cases that ran
 * nowhere" over a per-file table. That number does not belong in a docstring: a
 * second count of the same corpus on the same box gave 27, and I cannot
 * attribute the difference, so I will not present either as a fact. A recovered
 * count is a function of what the host has installed at that moment, which is
 * the one thing the receipt exists to stop mattering. No arm below depends on
 * it; they assert the WIRING, which is host-independent.
 *
 * # Why these arms and not a wiring grep
 *
 * The existing guards asserted that ids MATCH between the producer's catalogue
 * and the consumer's expectations. That is true of two halves nobody connects,
 * and it stayed true for the whole life of the defect. These arms produce a
 * receipt and hand it to the REAL consumer.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CAPABILITY_VERDICTS_ENV,
  CHROME_CAPABILITY_ID,
  campaignCapabilityIds,
  capabilityReceiptEnvForCampaign,
  type ProbeSpawner,
  produceCapabilityReceipt,
  type SpawnedProbe,
} from "../../../tools/dev/capability-probe-producer"
import type { CapabilityFinding } from "../../../tools/dev/capability-receipt"
import {
  CAPABILITY_LINE_PREFIX,
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_REQUIRE_ENV,
  capabilityRequiredFor,
} from "../../../tools/dev/capability-receipt"
import {
  __resetCapabilityReportingForTests,
  canExecute,
  capability,
  capabilityRequirementFailure,
  decideFromReceipt,
  loadCapabilityReceipt,
} from "../../../tools/dev/capability-receipt-consumer"
import { testEnvironmentSha256 } from "../../../tools/dev/test-shard-receipt"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/**
 * A spawner whose answer is decided by the argv, so the round trip is about the
 * WIRING and not about what this host happens to have installed.
 *
 * Keyed on what is MISSING, not on what is present: the first version matched any
 * argv token against an "available" set, and `[python3, -c, import debugpy]`
 * matched on `python3` — so a capability this host does not have came back
 * `executed` and the arm below passed for the wrong reason.
 */
const spawnerRefusing = (missing: readonly string[]): ProbeSpawner => {
  return (argv: readonly string[]): SpawnedProbe => {
    const line = argv.join(" ")
    const refused = missing.some((marker) => line.includes(marker))
    // Every field the contract declares, with no cast. The first version was an
    // `as unknown as SpawnedProbe` missing `stdout`, and the producer threw
    // inside the candidate that resolves its interpreter FROM stdout — a fake
    // that a cast let me build and the type would have refused.
    return {
      exited: Promise.resolve(refused ? 127 : 0),
      stdout: Promise.resolve(refused ? "" : `${argv[0] ?? "fake"}\n`),
      kill: () => {},
    }
  }
}

const produce = async (
  outPath: string,
  missing: readonly string[],
): Promise<Record<string, string>> => {
  const produced = await capabilityReceiptEnvForCampaign({
    repoRoot: REPO_ROOT,
    tier: "pr",
    head: "a".repeat(40),
    outPath,
    // REQUIRED, and deliberately not `process.env`: the producer's whole
    // correctness condition is that probes run under the env the CONSUMERS get.
    // bun does not typecheck test files, so an omitted required field here is
    // a `{...undefined}` that silently probes under an EMPTY env.
    probeEnv: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-probe-home" },
    spawn: spawnerRefusing(missing),
    totalDeadlineMs: 10_000,
  })
  return { ...produced.env }
}

describe("the capability receipt has a producer, and the consumer accepts it", () => {
  test("produce -> the real consumer reads it -> a present capability is EXECUTED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-wiring-"))
    try {
      const out = join(dir, "receipt.json")
      const env = await produce(out, ["debugpy", "lancedb"])

      // All THREE, exhaustively: the binding was silently optional (the consumer
      // compares it only when present) and the verdicts digest is what the shard
      // cache identity is allowed to move on. An arm that named two of three
      // passed while the third was absent.
      expect(Object.keys(env).sort()).toEqual(
        [
          CAPABILITY_RECEIPT_BINDING_ENV,
          CAPABILITY_RECEIPT_PATH_ENV,
          CAPABILITY_VERDICTS_ENV,
        ].sort(),
      )
      expect(env[CAPABILITY_RECEIPT_PATH_ENV]).toBe(out)
      expect(env[CAPABILITY_RECEIPT_BINDING_ENV]).toMatch(/^[0-9a-f]{64}$/)
      expect(env[CAPABILITY_VERDICTS_ENV]).toMatch(/^[0-9a-f]{64}$/)

      const load = loadCapabilityReceipt(env, (path) => readFileSync(path, "utf8"))
      expect(load.ok).toBe(true)
      expect(decideFromReceipt(load, "python3").verdict).toBe("executed")
      // ...and a capability the probe could not satisfy is NOT executed, so the
      // arm above is not reading a receipt that says yes to everything.
      expect(decideFromReceipt(load, "debugpy").verdict).not.toBe("executed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("PAIRED CONTROL — with no receipt env at all, every capability is BLOCKED", async () => {
    // This is the state the tree shipped in, and it is what turned gated
    // describes into skips that reported PASS.
    const load = loadCapabilityReceipt({}, (path) => readFileSync(path, "utf8"))
    expect(load.ok).toBe(false)
    if (load.ok) throw new Error("unreachable")
    expect(load.reason).toContain("the tier runner did not produce one")
    expect(decideFromReceipt(load, "python3").verdict).toBe("blocked-missing")
  })

  test("a receipt whose BINDING does not match is refused, not read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-binding-"))
    try {
      const out = join(dir, "receipt.json")
      const env = await produce(out, ["debugpy", "lancedb"])
      const wrong = { ...env, [CAPABILITY_RECEIPT_BINDING_ENV]: "9".repeat(64) }
      const load = loadCapabilityReceipt(wrong, (path) => readFileSync(path, "utf8"))
      expect(load.ok).toBe(false)
      if (load.ok) throw new Error("unreachable")
      expect(load.reason).toContain("binding")
      // PAIRED CONTROL: the honest pair still loads.
      expect(loadCapabilityReceipt(env, (path) => readFileSync(path, "utf8")).ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("the capability answer is part of the CACHE identity, the receipt path is not", () => {
    // Without this the runner would replay a green earned on a differently
    // capable host: the workers' env changed and the identity did not.
    const base = { PATH: process.env.PATH, HOME: "/h" }
    const digest = (extra: Record<string, string>): string =>
      testEnvironmentSha256({ ...base, ...extra }, 60_000, REPO_ROOT)

    // THE PATH does not move it: a per-pid receipt filename would otherwise miss
    // the cache on every campaign.
    const pathA = digest({ [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json" })
    const pathB = digest({ [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/b.json" })
    expect(pathA).toBe(pathB)

    // THE BINDING does not move it either, and this arm asserted the opposite
    // until the identity was measured. The binding digests
    // `{head, policySha256, toolchainSha256}`, and `toolchainSha256` is over each
    // tool's absolute path plus `dev:inode size mtime` — so it moves between two
    // checkouts of the same commit on the same box. Letting it into the identity
    // is a cache that can only miss, which looks exactly like one that works.
    const withBinding = (binding: string): string =>
      digest({
        [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json",
        [CAPABILITY_RECEIPT_BINDING_ENV]: binding,
        [CAPABILITY_VERDICTS_ENV]: "c".repeat(64),
      })
    expect(withBinding("a".repeat(64))).toBe(withBinding("b".repeat(64)))

    // THE VERDICTS DO. This is the one that matters: it digests which gated
    // describes will run, so a green earned where lancedb was absent is not
    // replayed on a host where it is present.
    const withVerdicts = (verdicts: string): string =>
      digest({
        [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json",
        [CAPABILITY_RECEIPT_BINDING_ENV]: "a".repeat(64),
        [CAPABILITY_VERDICTS_ENV]: verdicts,
      })
    expect(withVerdicts("c".repeat(64))).not.toBe(withVerdicts("d".repeat(64)))

    // ...and wiring the receipt at all changes the identity, so receipts minted
    // before the capability lanes could run are not reused for runs where they can.
    expect(digest({})).not.toBe(withVerdicts("c".repeat(64)))
  })
})

/**
 * One name and one grammar for the strictness switch.
 *
 * There were two, neither set anywhere: `QUANTA_REQUIRE_CAPABILITIES` (the
 * receipt consumer, where ANY non-empty value made EVERY capability strict) and
 * `QUANTA_REQUIRE_CAPABILITY` (the lane helper, `1` or a comma list). So the rule
 * "a blocked capability must be RED in a required job" was off in both dialects,
 * and arming one armed half the corpus with the wrong grammar.
 */
describe("required-capability switch", () => {
  const on = (value: string | undefined, id: string): boolean =>
    capabilityRequiredFor(id, value === undefined ? {} : { [CAPABILITY_REQUIRE_ENV]: value })

  test("unset, empty and 0 require nothing; 1 requires everything", () => {
    for (const value of [undefined, "", "0", "  "]) {
      expect({ value, required: on(value, "lancedb") }).toEqual({ value, required: false })
    }
    expect(on("1", "lancedb")).toBe(true)
    expect(on("1", "anything-at-all")).toBe(true)
  })

  test("a list requires exactly what it names — not everything", () => {
    // The precision the consumer lacked: naming one id made all of them strict,
    // which is a different run from the one the operator asked for.
    expect(on("lancedb", "lancedb")).toBe(true)
    expect(on("lancedb", "chrome-cdp")).toBe(false)
    expect(on("lancedb, debugpy", "debugpy")).toBe(true)
    expect(on("lancedb, debugpy", "python3")).toBe(false)
  })

  test("the lane helper and the receipt consumer read the SAME switch", async () => {
    const { capabilityRequired } = await import("../../_helpers/capability-lane")
    for (const value of ["1", "0", "lsp-rust"]) {
      const env = { [CAPABILITY_REQUIRE_ENV]: value }
      expect({ value, lane: capabilityRequired("lsp-rust", env) }).toEqual({
        value,
        lane: capabilityRequiredFor("lsp-rust", env),
      })
    }
    // ...and the retired singular name does nothing, so a stale export cannot
    // half-arm the corpus.
    expect(capabilityRequired("lsp-rust", { QUANTA_REQUIRE_CAPABILITY: "1" })).toBe(false)
  })
})

/**
 * ★ The strictness switch was unreachable from twelve of its fifteen consumers,
 * and the receipt path reported nothing at all.
 *
 * MEASURED across the corpus:
 *
 *   15 files consume the receipt (`canExecute`)
 *    3 of them call `requireCapability` — the three under `tests/contract/`
 *   12 call `canExecute` and nothing else
 *
 * So `QUANTA_REQUIRE_CAPABILITIES` armed 3/15 of its own corpus. The other
 * twelve selected `describe.skip` on `blocked-missing`, printed no line, and
 * exited 0. `tests/_helpers/capability-lane.ts` had already closed this exact
 * hole for the OTHER capability system, with a docstring explaining that
 * `available ? describe : describe.skip` "is wrong in exactly the case that
 * matters" — and the receipt system shipped the same shape anyway.
 *
 * These arms drive `canExecute` itself, which is where the requirement now
 * lives, so no future consumer can be written that bypasses it.
 */
describe("a required capability cannot be skipped past", () => {
  const REQUIRE = { QUANTA_REQUIRE_CAPABILITIES: "1" } as const

  /**
   * A receipt in which `id` TIMED OUT and `absent` was REFUSED, so one receipt
   * carries both verdicts and the control is not reading a receipt that says
   * yes to everything it was not asked about.
   */
  const timedOutReceipt = async (
    dir: string,
    id: string,
    absent: string,
  ): Promise<Record<string, string>> => {
    const produced = await capabilityReceiptEnvForCampaign({
      repoRoot: REPO_ROOT,
      tier: "pr",
      head: "b".repeat(40),
      outPath: join(dir, "timeout.json"),
      probeEnv: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-probe-home" },
      // Never settles, so the producer's total deadline decides — which is the
      // only way to get a real `probe-timeout` rather than a hand-built one.
      spawn: (argv: readonly string[]): SpawnedProbe => {
        const line = argv.join(" ")
        if (line.includes(id)) {
          return {
            exited: new Promise<number>(() => {}),
            stdout: new Promise<string>(() => {}),
            kill: () => {},
          }
        }
        const refused = line.includes(absent)
        return {
          exited: Promise.resolve(refused ? 127 : 0),
          stdout: Promise.resolve(refused ? "" : `${argv[0] ?? "fake"}\n`),
          kill: () => {},
        }
      },
      totalDeadlineMs: 700,
    })
    return { ...produced.env }
  }

  test("BLOCKED-MISSING under the switch is a throw, not a skip", () => {
    // The state the tree shipped in: no receipt anywhere.
    const load = loadCapabilityReceipt({}, (path) => readFileSync(path, "utf8"))
    const decision = decideFromReceipt(load, "git")
    expect(decision.verdict).toBe("blocked-missing")

    expect(capabilityRequirementFailure(decision, REQUIRE)).toContain("blocked-missing")
    // PAIRED CONTROL 1 — unset is the default and every ordinary local run.
    expect(capabilityRequirementFailure(decision, {})).toBeUndefined()
    expect(canExecute(decision)).toBe(false)
    // PAIRED CONTROL 2 — the list grammar names ONE id, so a different id is
    // still only a skip. Naming one used to make every id strict.
    expect(
      capabilityRequirementFailure(decision, { QUANTA_REQUIRE_CAPABILITIES: "lancedb" }),
    ).toBeUndefined()
    expect(
      capabilityRequirementFailure(decision, { QUANTA_REQUIRE_CAPABILITIES: "git" }),
    ).toContain("git")
  })

  test("PROBE-TIMEOUT is failed-setup, and failed-setup is not absence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-timeout-"))
    try {
      const env = await timedOutReceipt(dir, "debugpy", "lancedb")
      const load = loadCapabilityReceipt(env, (path) => readFileSync(path, "utf8"))
      expect(load.ok).toBe(true)

      const timedOut = decideFromReceipt(load, "debugpy")
      // "we could not find out" is a DIFFERENT fact from "this host lacks it",
      // and the consumer's status table is the only place that distinction
      // survives. It used to be laundered into a skip by the lane boundary.
      expect(timedOut.verdict).toBe("failed-setup")
      expect(capabilityRequirementFailure(timedOut, REQUIRE)).toContain("failed-setup")

      // PAIRED CONTROL — a capability that really is absent is
      // `skipped-unsupported`, and that stays a skip even under the switch,
      // because an absent tool is the answer the receipt exists to give.
      const absent = decideFromReceipt(load, "lancedb")
      expect(absent.verdict).toBe("skipped-unsupported")
      expect(capabilityRequirementFailure(absent, REQUIRE)).toBeUndefined()
      expect(canExecute(absent)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a probe that THROWS is probe-error, and probe-error is failed-setup", async () => {
    // The one `CapabilityStatus` nothing ever produced: declared, classified by
    // the consumer, and unreachable — a closed union with a dead arm, which is a
    // classification nobody can test. A rejected probe also used to reject the
    // whole `Promise.all` and take the campaign's entire receipt with it, so the
    // workers got NO receipt: every gated describe skipped, every file green.
    const dir = mkdtempSync(join(tmpdir(), "cap-throw-"))
    try {
      const out = join(dir, "receipt.json")
      const produced = await capabilityReceiptEnvForCampaign({
        repoRoot: REPO_ROOT,
        tier: "pr",
        head: "e".repeat(40),
        outPath: out,
        probeEnv: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-probe-home" },
        spawn: (argv: readonly string[]): SpawnedProbe => {
          if (argv.join(" ").includes("git")) throw new Error("spawn exploded")
          return {
            exited: Promise.resolve(0),
            stdout: Promise.resolve(`${argv[0] ?? "fake"}\n`),
            kill: () => {},
          }
        },
        totalDeadlineMs: 10_000,
      })
      expect(produced.receipt.capabilities.git?.status).toBe("probe-error")
      // PAIRED CONTROL — the other capabilities still answered, so one bad probe
      // no longer costs the campaign its receipt.
      expect(produced.receipt.capabilities.node?.status).toBe("available")

      const load = loadCapabilityReceipt(produced.env, (path) => readFileSync(path, "utf8"))
      expect(decideFromReceipt(load, "git").verdict).toBe("failed-setup")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("every receipt decision is REPORTED, behind the prefix both systems share", async () => {
    __resetCapabilityReportingForTests()
    const written: string[] = []
    const real = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      capability("git")
      capability("git")
    } finally {
      process.stdout.write = real
    }
    const lines = written.filter((line) => line.startsWith(CAPABILITY_LINE_PREFIX))
    // Exactly one: a tally that double-counts a file asking twice is not a tally.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("capability=git")
    // The VERDICT VALUE, not just the key. `toContain("verdict=")` was the whole
    // assertion, so hardcoding `verdict=executed` in the reported line — the
    // original "a lane that executed nothing looks like one that executed
    // everything" defect, reintroduced inside the line added to fix it — passed.
    expect(lines[0]).toContain("verdict=blocked-missing")

    // ...and it is the SAME prefix the lane system writes, so one grep spans
    // both halves instead of one.
    const { CAPABILITY_LINE_PREFIX: lanePrefix } = await import("../../_helpers/capability-lane")
    expect(lanePrefix).toBe(CAPABILITY_LINE_PREFIX)
  })

  test("the tally is keyed PER CAPABILITY, not per process", () => {
    // The dedupe Set's stated reason. The previous arm asked for one name twice
    // and asserted one line, which `if (reported.size > 0) return` also
    // satisfies — so the keying that the Set exists for was untested and a
    // process could report its first capability and go silent for the rest.
    __resetCapabilityReportingForTests()
    const written: string[] = []
    const real = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      capability("git")
      capability("node")
      capability("git")
    } finally {
      process.stdout.write = real
    }
    const lines = written.filter((line) => line.startsWith(CAPABILITY_LINE_PREFIX))
    expect(lines).toHaveLength(2)
    expect(lines.filter((line) => line.includes("capability=git"))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("capability=node"))).toHaveLength(1)
  })

  test("a REQUIRED capability that cannot run is a failing TEST, not a dead module", () => {
    // MEASURED before this: the requirement lived in `canExecute` and threw at
    // module scope, so Bun discarded each file's whole registry. Over the eight
    // consumer files under tests/unit/, `28 pass / 75 skip` became
    // `0 pass / 8 fail` — 95 tests gone, 28 of them passing and
    // capability-independent, with nothing saying coverage was lost.
    //
    // It also could not be reached through `gateOn(...) && canExecute(...)`,
    // which short-circuits: MEASURED `0 pass 21 skip 0 fail`, exit 0, with the
    // switch on and a `failed-setup` verdict on screen. `capability()` is called
    // unconditionally at module scope in every consumer, so the requirement
    // lives there now and nothing can route around it.
    const load = loadCapabilityReceipt({}, (path) => readFileSync(path, "utf8"))
    const blocked = decideFromReceipt(load, "debugpy")
    expect(
      capabilityRequirementFailure(blocked, { QUANTA_REQUIRE_CAPABILITIES: "debugpy" }),
    ).toContain("blocked-missing")
    // PAIRED CONTROL — a capability the switch does not name stays silent, so
    // naming one does not make every id strict.
    expect(
      capabilityRequirementFailure(blocked, { QUANTA_REQUIRE_CAPABILITIES: "lancedb" }),
    ).toBeUndefined()
  })
})

/**
 * ★ `chrome-cdp` was in the corpus's vocabulary and in NO receipt any production
 * path could mint.
 *
 * `capabilityReceiptEnvForCampaign` — the function the shard runner calls — had
 * no chrome parameter at all. `cliMain` was the only caller that set one, and
 * the CLI is invoked by nothing: not `package.json`, not `.github/workflows/`,
 * not `gate-manifest.ts`. So `capability("chrome-cdp")` answered
 * `blocked-missing` on every host, 17 gated tests across two browser files
 * skipped, and every one reported PASS.
 *
 * Three things kept it invisible:
 *
 *  - `produceCapabilityReceipt` gated the probe on
 *    `includeChrome === true && chromeProfileRoot !== undefined`, a SILENT AND:
 *    ask for chrome, forget the profile root, get a receipt without it and no
 *    diagnostic.
 *  - the drift guard that exists to catch "an id nothing probes" built its
 *    `known` set by hand and appended `CHROME_CAPABILITY_ID`, whitelisting the
 *    one id that was broken.
 *  - `probeChromeBringUp` drives the real browser port and ignores the injected
 *    spawner, so no arm could assert chrome was in a receipt without launching a
 *    browser. It is injectable now, which is what makes these arms possible.
 */
describe("a campaign receipt carries chrome", () => {
  const fakeChrome = async (): Promise<CapabilityFinding> => ({
    status: "available",
    detail: "fake bring-up",
    resolved: "/fake/chrome",
    probeMs: 1,
  })

  test("chrome is in the receipt, and the real consumer can execute it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-chrome-"))
    try {
      const out = join(dir, "receipt.json")
      const produced = await capabilityReceiptEnvForCampaign({
        repoRoot: REPO_ROOT,
        tier: "pr",
        head: "c".repeat(40),
        outPath: out,
        probeEnv: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-probe-home" },
        spawn: spawnerRefusing(["debugpy"]),
        probeChrome: fakeChrome,
        totalDeadlineMs: 10_000,
      })
      expect(Object.keys(produced.receipt.capabilities)).toContain(CHROME_CAPABILITY_ID)

      const load = loadCapabilityReceipt(produced.env, (path) => readFileSync(path, "utf8"))
      expect(decideFromReceipt(load, CHROME_CAPABILITY_ID).verdict).toBe("executed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("every id the corpus may ask for is one a campaign receipt carries", () => {
    // The SSOT the drift guard now reads instead of appending chrome by hand.
    const ids = campaignCapabilityIds({})
    expect(ids).toContain(CHROME_CAPABILITY_ID)
    // ANTI-VACUITY: the catalogue half must be there too, or the set could
    // shrink to the one hardcoded entry and still satisfy the line above.
    expect(ids.length).toBeGreaterThan(8)
    expect(ids).toContain("git")
  })

  test("asking for chrome without a profile root is REFUSED, not silently dropped", async () => {
    // The silent AND. A receipt minted without the capability answers
    // blocked-missing, which every gated describe turns into a skip reporting PASS.
    await expect(
      produceCapabilityReceipt({
        tier: "pr",
        binding: {
          head: "d".repeat(40),
          policySha256: "e".repeat(64),
          toolchainSha256: "f".repeat(64),
        },
        specs: [],
        includeChrome: true,
        probeChrome: fakeChrome,
        totalDeadlineMs: 1_000,
      }),
    ).rejects.toThrow(/chromeProfileRoot/)
  })
})

/**
 * ★ End to end, in a real `bun test` process.
 *
 * Every arm above drives a function. None of them proves `capability()` reaches
 * the requirement, and that wiring is the whole point: an audit's mutant that
 * disabled it left every arm green. These two spawn a real run of a real
 * consumer file, which is the only place the module-scope path exists.
 */
describe("the switch, in a real run of a real consumer", () => {
  const CONSUMER = "tests/unit/tool/glob-gitignore-mtime-hellgate.test.ts"

  const runConsumer = (extra: Record<string, string>): { out: string; code: number } => {
    const result = Bun.spawnSync([process.execPath, "test", CONSUMER], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      out: `${result.stdout.toString()}${result.stderr.toString()}`,
      code: result.exitCode ?? -1,
    }
  }

  test("a required-but-blocked capability fails the run, and names itself", () => {
    const armed = runConsumer({ QUANTA_REQUIRE_CAPABILITIES: "git" })
    expect(armed.out).toContain("REQUIRED git is blocked-missing")
    expect(armed.code).not.toBe(0)
  }, 60_000)

  test("PAIRED CONTROL — unset, the same file is green and reports its skips", () => {
    const quiet = runConsumer({ QUANTA_REQUIRE_CAPABILITIES: "" })
    expect(quiet.code).toBe(0)
    expect(quiet.out).not.toContain("REQUIRED git")
    // The skips still REPORT. A requirement that killed the module would take
    // these with it — measured at 95 tests lost across eight files when the
    // throw lived in `canExecute`.
    expect(quiet.out).toMatch(/\d+ skip/)
  }, 60_000)
})
