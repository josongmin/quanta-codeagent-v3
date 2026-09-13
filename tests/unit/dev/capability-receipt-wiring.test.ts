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
 *    3 of the 13 used to call `requireCapability` too (the `tests/contract/`
 *      three); the requirement now lives in `capability()` and they do not
 *
 * The numbers above were 15 and 33, and both were wrong. A bare grep for
 * `canExecute` over-counts, and by more as tests OF the mechanism accumulate: at
 * a128bc99d it matched 18 files outside `_helpers/`, five of them not consumers
 * (comments, fixtures, and the mechanism's own arms). Recompute by intersecting
 * the two facts that make a consumer, not by matching a word:
 *
 *   comm -12 \
 *     <(grep -rln canExecute tests --include='*.ts' | grep -v _helpers/ | sort) \
 *     <(grep -rln 'from "[^"]*capability-receipt-consumer"' tests --include='*.ts' | sort) \
 *     | grep -v capability-receipt-wiring
 *
 * With no receipt every one of those 17 resolves `blocked-missing`, which the
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
  type CapabilitySpec,
  CHROME_CAPABILITY_ID,
  campaignCapabilityIds,
  campaignIncludesChrome,
  campaignReceiptMissingIds,
  capabilityReceiptEnvForCampaign,
  type ProbeSpawner,
  probeCapability,
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
import { CAMPAIGN_CAPABILITY_ENV } from "../../../tools/dev/worker-home"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/**
 * An explicit environment with NO campaign receipt.
 *
 * Arms that assert a `blocked-missing` verdict must not read the ambient one.
 * Inside a shard worker `process.env` carries the campaign's receipt, where git
 * is `executed`, and three arms that read it were RED under every real campaign
 * — i.e. `bun run prepush` — while green for a developer running the file
 * directly. Nothing had run under a campaign since they landed, so nobody saw.
 */
const NO_RECEIPT: Readonly<Record<string, string>> = {}

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
 *    3 of them called `requireCapability` — the three under `tests/contract/`
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

  test("BLOCKED-MISSING under the switch is a requirement failure, not a skip", () => {
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
      capability("git", NO_RECEIPT)
      capability("git", NO_RECEIPT)
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

  test("capability() reads the receipt from the env it is GIVEN, both ways round", async () => {
    // It read the process-cached receipt whatever env it was handed, so an arm
    // passing `{}` still got the campaign's answer inside a shard worker, and an
    // arm passing a real receipt got the ambient absence outside one. Each of the
    // two assertions below catches that in one of those two environments.
    const dir = mkdtempSync(join(tmpdir(), "cap-env-"))
    try {
      const produced = await produce(join(dir, "receipt.json"), [])
      // Passed as a literal of the two variables the consumer reads. The callsite
      // scan treats any env it cannot prove inert — like `produced` itself — as the
      // campaign's receipt, and asks that of a call inside a test.
      const givenEnv = {
        [CAPABILITY_RECEIPT_PATH_ENV]: produced[CAPABILITY_RECEIPT_PATH_ENV],
        [CAPABILITY_RECEIPT_BINDING_ENV]: produced[CAPABILITY_RECEIPT_BINDING_ENV],
      }
      expect(capability("git", givenEnv).verdict).toBe("executed")
      expect(capability("git", NO_RECEIPT).verdict).toBe("blocked-missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

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
      capability("git", NO_RECEIPT)
      capability("node", NO_RECEIPT)
      capability("git", NO_RECEIPT)
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

  test("the browser file's fail-loud arm: a slow bring-up is failed-setup, a refusal is a regression", async () => {
    // Driven through the REAL browser file with a produced receipt. The arm used
    // to key on `resolved`, which a bring-up TIMEOUT also carries, so a loaded
    // host read as an adapter regression.
    const BROWSER = "tests/integration/browser-real-chrome-e2e.test.ts"
    const runWith = async (finding: CapabilityFinding): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), "cap-chrome-loud-"))
      try {
        const produced = await capabilityReceiptEnvForCampaign({
          repoRoot: REPO_ROOT,
          tier: "pr",
          head: "f".repeat(40),
          outPath: join(dir, "receipt.json"),
          probeEnv: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-probe-home" },
          spawn: spawnerRefusing([]),
          probeChrome: async () => finding,
          totalDeadlineMs: 10_000,
        })
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !CAMPAIGN_CAPABILITY_ENV.includes(key) && key !== CAPABILITY_REQUIRE_ENV,
          ),
        )
        const result = Bun.spawnSync([process.execPath, "test", BROWSER, "-t", "presence report"], {
          cwd: REPO_ROOT,
          env: { ...inherited, ...produced.env },
          stdout: "pipe",
          stderr: "pipe",
        })
        return `${result.stdout.toString()}${result.stderr.toString()}`
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const slow = await runWith({
      status: "probe-timeout",
      detail: "chrome bring-up did not finish within 45000ms",
      resolved: "chromium",
      probeMs: 45_000,
    })
    // PRECONDITION: the file really saw the injected verdict.
    expect(slow).toContain(`capability=${CHROME_CAPABILITY_ID} verdict=failed-setup`)
    expect(slow).toMatch(/\b0 fail\b/)
    const refused = await runWith({
      status: "unavailable",
      detail: "chrome present but the CDP session would not come up: spawn-failed",
      resolved: "chromium",
      probeMs: 900,
    })
    expect(refused).toContain(`capability=${CHROME_CAPABILITY_ID} verdict=skipped-unsupported`)
    expect(refused).toContain(
      "(fail) browser real-chrome e2e — chrome presence report > chrome present",
    )
    expect(refused).toMatch(/\b1 fail\b/)
  }, 90_000)

  test("every id the corpus may ask for is one a campaign receipt carries", () => {
    // The SSOT the drift guard now reads instead of appending chrome by hand.
    const ids = campaignCapabilityIds({})
    expect(ids).toContain(CHROME_CAPABILITY_ID)
    // ANTI-VACUITY: the catalogue half must be there too, or the set could
    // shrink to the one hardcoded entry and still satisfy the line above.
    expect(ids.length).toBeGreaterThan(8)
    expect(ids).toContain("git")
  })

  test("chrome without a profile root cannot be WRITTEN", () => {
    // It was three independent optionals, and "include, no root" was a SILENT
    // AND that dropped chrome from the receipt. The runtime throw added for it
    // could be undone by a different conjunct with every arm green. As one
    // option object the state is unrepresentable, and `typecheck:all` — which
    // runs over test files — is what enforces the line below.
    const options: Parameters<typeof produceCapabilityReceipt>[0] = {
      tier: "pr",
      binding: {
        head: "d".repeat(40),
        policySha256: "e".repeat(64),
        toolchainSha256: "f".repeat(64),
      },
      // @ts-expect-error — a chrome option with no profile root does not typecheck
      chrome: { probe: fakeChrome },
    }
    expect(options.tier).toBe("pr")
  })

  test("chrome runs INSIDE the total deadline, and a throwing probe costs only chrome", async () => {
    const binding = {
      head: "d".repeat(40),
      policySha256: "e".repeat(64),
      toolchainSha256: "f".repeat(64),
    }
    const good: CapabilitySpec = {
      id: "fixture-good",
      description: "fixture",
      candidates: [{ label: "g", argv: ["good"] }],
      perCandidateTimeoutMs: 1_000,
    }
    const answer: ProbeSpawner = () => ({
      exited: Promise.resolve(0),
      stdout: Promise.resolve(""),
      kill: () => {},
    })

    // A chrome bring-up that never finishes. It used to run AFTER the deadline
    // had been spent, with its own 45s budget on top. The contract, not a wall
    // bound: a probe that never answers can only come back through the
    // producer's total deadline, and the detail says that is what decided it.
    const hung = await produceCapabilityReceipt({
      tier: "pr",
      binding,
      specs: [good],
      spawn: answer,
      chrome: { profileRoot: "/unused", probe: () => new Promise<CapabilityFinding>(() => {}) },
      totalDeadlineMs: 300,
    })
    expect(hung.capabilities[CHROME_CAPABILITY_ID]?.status).toBe("probe-timeout")
    expect(hung.capabilities[CHROME_CAPABILITY_ID]?.detail).toBe(
      "the producer's total deadline (300ms) fired before chrome answered",
    )
    expect(hung.capabilities["fixture-good"]?.status).toBe("available")

    // A chrome probe that THROWS. Outside the per-probe catch it took the whole
    // receipt with it.
    const threw = await produceCapabilityReceipt({
      tier: "pr",
      binding,
      specs: [good],
      spawn: answer,
      chrome: {
        profileRoot: "/unused",
        probe: async () => {
          throw new Error("browser port exploded")
        },
      },
      totalDeadlineMs: 5_000,
    })
    expect(threw.capabilities[CHROME_CAPABILITY_ID]?.status).toBe("probe-error")
    expect(threw.capabilities["fixture-good"]?.status).toBe("available")
  })

  test("a campaign receipt missing an expected id is NAMED, not minted", () => {
    const ids = campaignCapabilityIds({})
    const full = Object.fromEntries(
      ids.map((id) => [id, { status: "available" as const, detail: "fixture", probeMs: 1 }]),
    )
    expect(campaignReceiptMissingIds({ capabilities: full }, true, {})).toEqual([])

    const { [CHROME_CAPABILITY_ID]: _chrome, ...withoutChrome } = full
    expect(campaignReceiptMissingIds({ capabilities: withoutChrome }, true, {})).toEqual([
      CHROME_CAPABILITY_ID,
    ])
    // PAIRED CONTROL — a campaign that did not include chrome does not expect it,
    // so a wiring test with an injected spawner is not refused.
    expect(campaignReceiptMissingIds({ capabilities: withoutChrome }, false, {})).toEqual([])
  })

  test("whether a campaign probes chrome is PINNED, not inlined", () => {
    // The inline expression could be narrowed to `includeChrome ?? probeChrome
    // !== undefined` with every arm green, because the only arm that reached the
    // default injected `probeChrome` — and the shard runner passes neither
    // `spawn` nor `probeChrome`, so chrome would be in no receipt again.
    const fakeSpawn: ProbeSpawner = () => ({
      exited: Promise.resolve(0),
      stdout: Promise.resolve(""),
      kill: () => {},
    })
    const table: readonly [Parameters<typeof campaignIncludesChrome>[0], boolean][] = [
      [{}, true], // the shard runner's call: chrome IS probed
      [{ spawn: fakeSpawn }, false], // a wiring test must not launch a browser
      [{ spawn: fakeSpawn, probeChrome: fakeChrome }, true],
      [{ probeChrome: fakeChrome }, true],
      [{ includeChrome: false }, false],
      [{ includeChrome: true, spawn: fakeSpawn }, true],
    ]
    for (const [input, expected] of table) {
      expect({ input: Object.keys(input), probes: campaignIncludesChrome(input) }).toEqual({
        input: Object.keys(input),
        probes: expected,
      })
    }
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
    // The campaign's receipt variables are REMOVED before `extra` is applied.
    // Inherited, they made git `executed` in the child, so the armed run fired no
    // REQUIRED failure and both arms failed inside every shard worker.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !CAMPAIGN_CAPABILITY_ENV.includes(key)),
    )
    const result = Bun.spawnSync([process.execPath, "test", CONSUMER], {
      cwd: REPO_ROOT,
      env: { ...inherited, ...extra },
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
    // PRECONDITION: the child really had no receipt. Without this the arm could
    // be green or red for reasons that have nothing to do with the switch.
    expect(armed.out).toContain("verdict=blocked-missing")
    expect(armed.out).toContain("REQUIRED git is blocked-missing")
    expect(armed.code).not.toBe(0)
    // THE FILE SURVIVED. The requirement used to throw at module scope, which
    // discards the whole registry; an audit's mutant restoring that throw kept
    // the two lines above green, because the REQUIRED text still printed and
    // the exit code was still non-zero. Exactly one failure and the file's own
    // skips still reported is what separates a failing test from a dead module.
    expect(armed.out).toMatch(/\b1 fail\b/)
    expect(armed.out).toMatch(/\b[1-9]\d* skip\b/)
  }, 60_000)

  test("PAIRED CONTROL — armed, with a receipt that says git RUNS, the file is green", async () => {
    // The switch must key on the VERDICT, not merely on being set. This is also
    // exactly what a shard worker sees, which is the environment the two arms
    // around it were red in before they stopped inheriting the receipt.
    const dir = mkdtempSync(join(tmpdir(), "cap-armed-ok-"))
    try {
      const receiptEnv = await produce(join(dir, "receipt.json"), [])
      const armed = runConsumer({ ...receiptEnv, QUANTA_REQUIRE_CAPABILITIES: "git" })
      expect(armed.out).toContain("verdict=executed")
      expect(armed.out).not.toContain("REQUIRED git")
      expect(armed.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("PAIRED CONTROL — unset, the same file is green and reports its skips", () => {
    const quiet = runConsumer({ QUANTA_REQUIRE_CAPABILITIES: "" })
    expect(quiet.out).toContain("verdict=blocked-missing")
    expect(quiet.code).toBe(0)
    expect(quiet.out).not.toContain("REQUIRED git")
    // The skips still REPORT. A requirement that killed the module would take
    // these with it — measured at 95 tests lost across eight files when the
    // throw lived in `canExecute`.
    expect(quiet.out).toMatch(/\d+ skip/)
  }, 60_000)
})

/**
 * ★ Three failure kinds, and the order between them.
 *
 * `Bun.spawn` THROWS synchronously for a binary that is not installed, so
 * "this host lacks the tool" arrives as a throw. The commit that introduced
 * `probe-error` classified every throw that way, and an audit measured the
 * regression on this host: `ast-grep`, simply not installed, went from
 * `unavailable` to `probe-error` → `failed-setup`. Driven through
 * `probeCapability` with fixed specs, so each rule is pinned on its own.
 */
describe("absence, a probe that could not run, and a probe that did not answer", () => {
  const spec = (
    argvs: readonly (readonly string[])[],
    perCandidateTimeoutMs = 2_000,
  ): CapabilitySpec => ({
    id: "fixture",
    description: "fixture",
    candidates: argvs.map((argv, index) => ({ label: `c${index}`, argv })),
    perCandidateTimeoutMs,
  })
  const throwing = (code: string | undefined): never => {
    const error = new Error(`fixture ${code ?? "no code"}`) as Error & { code?: string }
    if (code !== undefined) error.code = code
    throw error
  }
  const answering = (exit: number): SpawnedProbe => ({
    exited: Promise.resolve(exit),
    stdout: Promise.resolve(""),
    kill: () => {},
  })

  test("ENOENT is ABSENCE, not a probe failure", async () => {
    const finding = await probeCapability(spec([["missing-binary"]]), () => throwing("ENOENT"))
    expect(finding.status).toBe("unavailable")
    expect(finding.detail).toContain("ENOENT")
  })

  test("any OTHER throw means the probe could not run", async () => {
    for (const code of ["EACCES", "EMFILE", undefined]) {
      const finding = await probeCapability(spec([["x"]]), () => throwing(code))
      expect({ code, status: finding.status }).toEqual({ code, status: "probe-error" })
    }
  })

  test("a missing preferred interpreter beside a definitive no is ABSENCE", async () => {
    // The real shape: `python3.11` is not installed, `python3` answers exit 1.
    // Under the regression this was `probe-error` on every host without Homebrew
    // python3.11, for a module that is simply not there.
    const finding = await probeCapability(spec([["python3.11"], ["python3"]]), (argv) =>
      argv[0] === "python3.11" ? throwing("ENOENT") : answering(1),
    )
    expect(finding.status).toBe("unavailable")
  })

  test("a probe that COULD NOT RUN outranks one that did not answer", async () => {
    const finding = await probeCapability(spec([["a"], ["b"]], 50), (argv) =>
      argv[0] === "a"
        ? throwing("EMFILE")
        : {
            exited: new Promise<number>(() => {}),
            stdout: new Promise<string>(() => {}),
            kill: () => {},
          },
    )
    expect(finding.status).toBe("probe-error")
  })

  test("a probe whose exit REJECTS does not take the receipt with it", async () => {
    // A rejected `exited` escapes `runCandidate`, rejects `probeCapability`, and
    // used to reject the producer's whole `Promise.all`: one bad probe, no
    // receipt, every gated describe skipped, every file green. The earlier arm
    // for this used a spawner that throws synchronously, which `runCandidate`
    // already caught — so the producer-level catch was never reached by it.
    const produced = await produceCapabilityReceipt({
      tier: "pr",
      binding: {
        head: "a".repeat(40),
        policySha256: "b".repeat(64),
        toolchainSha256: "c".repeat(64),
      },
      specs: [spec([["bad"]]), { ...spec([["good"]]), id: "fixture-good" }],
      spawn: (argv) =>
        argv[0] === "bad"
          ? {
              exited: Promise.reject(new Error("exit rejected")),
              stdout: Promise.resolve(""),
              kill: () => {},
            }
          : answering(0),
      totalDeadlineMs: 5_000,
    })
    expect(produced.capabilities.fixture?.status).toBe("probe-error")
    expect(produced.capabilities["fixture-good"]?.status).toBe("available")
  })
})
