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
 * MEASURED on this box, the same files with and without a receipt:
 *
 *   glob-gitignore-mtime-hellgate        0 pass / 8 skip  ->  8 pass
 *   cha-multisite-hellgate               5 pass / 9 skip  -> 14 pass
 *   project-env-snapshot-wiring          0 pass / 3 skip  ->  3 pass
 *   contract/lsp-pyright                 0 pass / 1 skip  ->  3 pass
 *   contract/lsp-typescript              0 pass / 1 skip  ->  3 pass
 *   sphinx-ra-shim                       0 pass / 3 skip  ->  2 pass
 *   ast-grep {bugs,e2e,scenarios}       23 pass / 31 skip -> 28 pass
 *
 * Thirty-three cases that ran nowhere. The files that still skip — browser,
 * sandbox, debugpy — skip because the host genuinely lacks chromium, bwrap and
 * debugpy, which is the answer the receipt exists to give.
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
  capabilityReceiptEnvForCampaign,
  type ProbeSpawner,
  type SpawnedProbe,
} from "../../../tools/dev/capability-probe-producer"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_REQUIRE_ENV,
  capabilityRequiredFor,
} from "../../../tools/dev/capability-receipt"
import {
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

      // Both halves, because the binding was silently optional: the consumer
      // compares it only when this second variable is present.
      expect(Object.keys(env).sort()).toEqual(
        [CAPABILITY_RECEIPT_BINDING_ENV, CAPABILITY_RECEIPT_PATH_ENV].sort(),
      )
      expect(env[CAPABILITY_RECEIPT_PATH_ENV]).toBe(out)
      expect(env[CAPABILITY_RECEIPT_BINDING_ENV]).toMatch(/^[0-9a-f]{64}$/)

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

    const pathA = digest({ [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json" })
    const pathB = digest({ [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/b.json" })
    expect(pathA).toBe(pathB)

    const bindingA = digest({
      [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json",
      [CAPABILITY_RECEIPT_BINDING_ENV]: "a".repeat(64),
    })
    const bindingB = digest({
      [CAPABILITY_RECEIPT_PATH_ENV]: "/tmp/a.json",
      [CAPABILITY_RECEIPT_BINDING_ENV]: "b".repeat(64),
    })
    expect(bindingA).not.toBe(bindingB)
    // ...and wiring the receipt at all changes the identity, so receipts minted
    // before the capability lanes could run are not reused for runs where they can.
    expect(digest({})).not.toBe(pathA)
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
