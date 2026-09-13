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
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import ts from "typescript"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_VERDICTS_ENV,
} from "../../../tools/dev/capability-receipt"
import { ShardProcessRegistry } from "../../../tools/dev/test-shard-lifecycle"
import { type WorkerSpawnEnvInput, workerSpawnEnv } from "../../../tools/dev/worker-home"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

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

  test("the runner's OWN environment never supplies a receipt", () => {
    // The all-or-nothing check looked only at the bag. With an empty bag, a stale
    // receipt in the runner's env — measured: a path with NO binding — went
    // straight through to the worker, which is the unbound receipt the check
    // exists to refuse.
    for (const stale of [
      { ...CAPABILITY_ENV },
      { [CAPABILITY_RECEIPT_PATH_ENV]: "/stale/receipt.json" },
    ]) {
      const env = workerSpawnEnv(input({ base: { PATH: "/usr/bin", ...stale }, capabilityEnv: {} }))
      for (const key of [
        CAPABILITY_RECEIPT_PATH_ENV,
        CAPABILITY_RECEIPT_BINDING_ENV,
        CAPABILITY_VERDICTS_ENV,
      ]) {
        expect({ stale: Object.keys(stale).length, key, value: env[key] }).toEqual({
          stale: Object.keys(stale).length,
          key,
          value: undefined,
        })
      }
    }
  })

  test("PRESENT means an own, non-empty string; nothing else rides in the bag", () => {
    // Inherited through the prototype: `key in bag` counted it, the spread
    // delivered nothing.
    const inherited = Object.create({ ...CAPABILITY_ENV }) as Record<string, string>
    expect(
      workerSpawnEnv(input({ capabilityEnv: inherited }))[CAPABILITY_RECEIPT_PATH_ENV],
    ).toBeUndefined()
    // Own but empty.
    expect(() =>
      workerSpawnEnv(
        input({ capabilityEnv: { ...CAPABILITY_ENV, [CAPABILITY_RECEIPT_BINDING_ENV]: "" } }),
      ),
    ).toThrow(/present but empty/)
    // Anything that is not one of the three.
    expect(() =>
      workerSpawnEnv(input({ capabilityEnv: { ...CAPABILITY_ENV, QUANTA_SOMETHING_ELSE: "x" } })),
    ).toThrow(/not a campaign capability variable/)
  })

  test("an EMPTY capability env is legal, because a partial one is not", () => {
    // Some suites legitimately run with no receipt tier. What must never happen
    // is two of three variables: the consumer compares the binding only when it
    // is present, so a path without a binding reads an UNBOUND receipt.
    const none = workerSpawnEnv(input({ capabilityEnv: {} }))
    expect(none[CAPABILITY_RECEIPT_PATH_ENV]).toBeUndefined()
    expect(none.HOME).toBe("/run/worker-3/home")

    // ...and PARTIAL is refused, which the docstring claimed and nothing
    // enforced. The consumer compares the binding only when it is present, so a
    // path without one is an UNBOUND receipt; and without the verdicts digest a
    // worker replays a green earned on a differently capable host.
    for (const missing of [
      CAPABILITY_RECEIPT_PATH_ENV,
      CAPABILITY_RECEIPT_BINDING_ENV,
      CAPABILITY_VERDICTS_ENV,
    ]) {
      const partial = Object.fromEntries(
        Object.entries(CAPABILITY_ENV).filter(([key]) => key !== missing),
      )
      expect(() => workerSpawnEnv(input({ capabilityEnv: partial }))).toThrow(
        /partial capability env/,
      )
    }
  })
})

/**
 * ★ The composition is correct and nothing proved the runner CALLS it.
 *
 * That is the defect class this whole ticket is about — fifteen consumers and no
 * producer — reproduced inside its own fix. An audit found the mutant:
 * `capabilityEnv: {}` at the one call site in `run-test-shards.ts` reinstates
 * the original failure (every worker launched without the receipt, every gated
 * describe skipped, every file reporting PASS) with every arm above still green,
 * and it is both typecheck-clean and lint-clean.
 *
 * `run-test-shards.ts` ends in a top-level `await main()` and cannot be
 * imported, so the call site is reached by PARSING it. A `toContain` would not
 * do: the mutant leaves the identifier `capabilityEnv` in place as a property
 * name. What distinguishes them is the property's VALUE — a reference to the
 * campaign's bag, or a literal standing in for it.
 */
describe("the runner really hands the receipt to the worker", () => {
  const RUNNER = join(REPO_ROOT, "tools", "dev", "run-test-shards.ts")

  test("WIRING — the spawn's env is workerSpawnEnv, fed the campaign's own bag", () => {
    const source = ts.createSourceFile(
      "run-test-shards.ts",
      readFileSync(RUNNER, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )

    const spawnCalls: ts.CallExpression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "spawnWorker"
      ) {
        spawnCalls.push(node)
      }
      node.forEachChild(walk)
    }
    walk(source)

    // ANTI-VACUITY: exactly one live spawn. Zero means the parse missed it and
    // every assertion below would be over an empty set.
    expect(spawnCalls).toHaveLength(1)
    const options = spawnCalls[0]?.arguments[0]
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      throw new Error("spawnWorker is not called with an object literal")
    }
    const property = options.properties.find(
      (one): one is ts.PropertyAssignment =>
        ts.isPropertyAssignment(one) && ts.isIdentifier(one.name) && one.name.text === "env",
    )
    if (property === undefined) throw new Error("spawnWorker has no `env` property")

    // The env must BE the checked composition, not an object literal beside it.
    expect(ts.isCallExpression(property.initializer)).toBe(true)
    const call = property.initializer as ts.CallExpression
    expect(ts.isIdentifier(call.expression) ? call.expression.text : "").toBe("workerSpawnEnv")

    const input = call.arguments[0]
    if (input === undefined || !ts.isObjectLiteralExpression(input)) {
      throw new Error("workerSpawnEnv is not called with an object literal")
    }
    const capability = input.properties.find(
      (one) =>
        (ts.isPropertyAssignment(one) || ts.isShorthandPropertyAssignment(one)) &&
        ts.isIdentifier(one.name) &&
        one.name.text === "capabilityEnv",
    )
    if (capability === undefined) throw new Error("workerSpawnEnv is not given capabilityEnv")
    // Shorthand (`capabilityEnv,`) or a plain identifier. A literal — `{}`, or
    // anything else standing in for the campaign's bag — is the mutant.
    if (ts.isPropertyAssignment(capability)) {
      expect(ts.isIdentifier(capability.initializer)).toBe(true)
    } else {
      expect(ts.isShorthandPropertyAssignment(capability)).toBe(true)
    }
  })

  test("BEHAVIOUR — all three variables reach a real child process", async () => {
    // The composition arms are pure. This one spawns the REAL registry worker
    // the runner uses, so "the bag is right" becomes "a process got it". One
    // `bun -e` child, no campaign, no lease.
    const dir = mkdtempSync(join(tmpdir(), "spawn-proof-"))
    const fds: number[] = []
    try {
      const outPath = join(dir, "out.json")
      const fd = openSync(outPath, "w")
      // Closed in `finally`: it leaked one descriptor per execution, measured.
      fds.push(fd)
      const registry = new ShardProcessRegistry()
      const handle = registry.spawnWorker({
        // `process.execPath`, not "bun": the fixture base deliberately carries a
        // minimal PATH, and resolving the runtime through it would make this arm
        // depend on the developer's shell.
        cmd: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({" +
            "receipt:process.env.QUANTA_CAPABILITY_RECEIPT," +
            "binding:process.env.QUANTA_CAPABILITY_BINDING," +
            "verdicts:process.env.QUANTA_CAPABILITY_VERDICTS," +
            "require:process.env.QUANTA_REQUIRE_CAPABILITIES," +
            "home:process.env.HOME}))",
        ],
        cwd: REPO_ROOT,
        env: workerSpawnEnv(
          input({
            // The strictness switch rides in the BASE, not the bag: it is what
            // turns a dropped bag into a named failure, so it must survive the
            // real spawn path too — an audit's mutant stripping it there left
            // every arm green.
            base: { PATH: process.env.PATH ?? "", QUANTA_REQUIRE_CAPABILITIES: "git,lancedb" },
            workerHome: join(dir, "home"),
          }),
        ),
        stdoutFd: fd,
        stderrFd: fd,
      })
      const exit = await handle.exited
      expect(exit.code).toBe(0)
      const seen = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, string>
      expect(seen.receipt).toBe(CAPABILITY_ENV[CAPABILITY_RECEIPT_PATH_ENV])
      expect(seen.binding).toBe(CAPABILITY_ENV[CAPABILITY_RECEIPT_BINDING_ENV])
      expect(seen.verdicts).toBe(CAPABILITY_ENV[CAPABILITY_VERDICTS_ENV])
      expect(seen.require).toBe("git,lancedb")
      expect(seen.home).toBe(join(dir, "home"))
    } finally {
      for (const fd of fds) closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
