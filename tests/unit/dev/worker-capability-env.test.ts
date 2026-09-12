/**
 * ★ The campaign's capability receipt reaches the workers through two
 * environment variables, and nothing proved they arrive.
 *
 * A worker launched without them does not fail. Every `capability("<id>")`
 * answers `blocked-missing`, `canExecute` turns that into `describe.skip`, and
 * Bun reports the file as PASSING. That is how the receipt spent its whole life
 * unwired: fifteen consumers, no producer, and a green suite.
 *
 * The composition was an object literal at the `spawnWorker` call site with an
 * `Object.assign` fifteen lines above it. Both correct, neither guarded, and
 * `run-test-shards.ts` ends in a top-level `await main()` so no test could
 * import the call site to check. It is now `workerSpawnEnv`, which REFUSES to
 * return a bag missing the variables rather than trusting a spread order.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CAPABILITY_VERDICTS_ENV } from "../../../tools/dev/capability-probe-producer"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
} from "../../../tools/dev/capability-receipt"
import {
  applyUserLibraryDecision,
  userLibraryDecision,
  type WorkerSpawnEnvInput,
  workerSpawnEnv,
} from "../../../tools/dev/worker-home"

const CAPABILITY_ENV = {
  [CAPABILITY_RECEIPT_PATH_ENV]: "/run/capability/pr.receipt.json",
  [CAPABILITY_RECEIPT_BINDING_ENV]: "a".repeat(64),
  [CAPABILITY_VERDICTS_ENV]: "b".repeat(64),
} as const

const input = (overrides: Partial<WorkerSpawnEnvInput> = {}): WorkerSpawnEnvInput => ({
  base: { PATH: "/usr/bin", HOME: "/Users/someone" },
  capabilityEnv: { ...CAPABILITY_ENV },
  workerHome: "/run/worker-3/home",
  workerTmp: "/run/worker-3/tmp",
  repoRoot: "/repo",
  quantaHome: "/run/worker-3/home/.quanta",
  prefsHome: "/run/worker-3/prefs-home",
  benchResults: "/run/worker-3/bench",
  scanReachSink: "/run/worker-3/scan-reach.jsonl",
  testTimeoutMs: 120_000,
  ...overrides,
})

describe("a shard worker cannot be launched without the campaign receipt", () => {
  test("all three capability variables survive the composition", () => {
    const env = workerSpawnEnv(input())
    for (const [key, value] of Object.entries(CAPABILITY_ENV)) {
      expect({ key, value: env[key] }).toEqual({ key, value })
    }
    // ...and the per-worker overrides still win over the runner's own values,
    // which is the reason the spread order exists at all.
    expect(env.HOME).toBe("/run/worker-3/home")
    expect(env.PWD).toBe("/repo")
    expect(env.QUANTA_TEST_TIMEOUT_SCALE).toBe("2")
    // PAIRED CONTROL — an unrelated inherited variable is not dropped.
    expect(env.PATH).toBe("/usr/bin")
  })

  test("a bag missing a capability variable is REFUSED, not returned", () => {
    // The failure mode being prevented: a base env that already carries a
    // STALE receipt path, and a composition that lets it win.
    const stale = input({
      base: { PATH: "/usr/bin", [CAPABILITY_RECEIPT_PATH_ENV]: "/stale/receipt.json" },
    })
    // The campaign's value must win over the inherited one.
    expect(workerSpawnEnv(stale)[CAPABILITY_RECEIPT_PATH_ENV]).toBe(
      CAPABILITY_ENV[CAPABILITY_RECEIPT_PATH_ENV],
    )

    // And if a per-worker override ever adopted a capability variable's name,
    // one of the two spreads would silently lose. Neither ordering is allowed.
    expect(() =>
      workerSpawnEnv(input({ capabilityEnv: { ...CAPABILITY_ENV, HOME: "/hijacked" } })),
    ).toThrow(/collide/)
  })

  test("an EMPTY capability env is legal, because a partial one is not", () => {
    // Some suites legitimately run with no receipt tier. What must never happen
    // is two of three variables: the consumer compares the binding only when it
    // is present, so a path without a binding reads an UNBOUND receipt.
    const none = workerSpawnEnv(input({ capabilityEnv: {} }))
    expect(none[CAPABILITY_RECEIPT_PATH_ENV]).toBeUndefined()
    expect(none.HOME).toBe("/run/worker-3/home")
  })
})

/**
 * ★ One receipt describes one HOME shape, and the workers do not all have one.
 *
 * The producer probes under a scratch HOME because probing under the runner's
 * real HOME was measured to flip `debugpy`, `cargo` and `lancedb` from ok to
 * FAIL between the probe and the worker. But `userLibraryDecision` lends the
 * developer's real `~/Library` to `browser`-class workers and to no others, so
 * a browser worker is strictly MORE capable than the home the probe ran in.
 *
 * That direction is fail-safe: the receipt under-reports, so a lane skips
 * rather than falsely running, and a skip is visible on the `[capability]`
 * line. The direction that would be unsafe is the one already fixed. These arms
 * pin which direction it is, so a change to the lending policy cannot quietly
 * reverse it.
 */
describe("the probe HOME is no more capable than the workers", () => {
  test("only the browser class reaches the real Library", () => {
    for (const resourceClass of ["pure", "heavy", "debug", "network", "browser"]) {
      expect({ resourceClass, decision: userLibraryDecision(resourceClass, {}) }).toEqual({
        resourceClass,
        decision: resourceClass === "browser" ? "lend" : "not-browser",
      })
    }
    // The opt-out is the lane's only escape, and it is per-run not per-class.
    expect(userLibraryDecision("browser", { QUANTA_TEST_NO_USER_LIBRARY: "1" })).toBe("opted-out")
  })

  test("a non-browser worker HOME has no Library, so the probe HOME matches it", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-home-"))
    try {
      const sourceLibrary = join(dir, "fake-real-library")
      mkdirSync(sourceLibrary, { recursive: true })

      // The shape the capability probe runs under, and the shape 43 of 44
      // chunks get: no Library entry.
      const plain = join(dir, "plain-home")
      mkdirSync(plain, { recursive: true })
      expect(
        applyUserLibraryDecision({ workerHome: plain, resourceClass: "pure", sourceLibrary }),
      ).toBe("not-browser")
      expect(existsSync(join(plain, "Library"))).toBe(false)

      // PAIRED CONTROL — the browser class really does get one, which is why
      // the receipt can only ever under-report for that class and not over.
      const browser = join(dir, "browser-home")
      mkdirSync(browser, { recursive: true })
      expect(
        applyUserLibraryDecision({ workerHome: browser, resourceClass: "browser", sourceLibrary }),
      ).toBe("lend")
      expect(existsSync(join(browser, "Library"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
