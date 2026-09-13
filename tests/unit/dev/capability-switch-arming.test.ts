/**
 * ★ The receipt chain had one runtime proof: its last hop.
 *
 * A campaign produces a capability receipt, puts three variables in a bag, and
 * hands the bag to each worker. The arms around it proved the bag was composed
 * and that the consumer reads it. What no arm could see was a hop that DROPPED
 * it: a worker without the receipt answers `blocked-missing`, `canExecute`
 * turns that into `describe.skip`, and Bun reports a pass. An audit counted
 * eight mutants on the hops before the last one that left every arm green.
 *
 * The runner now arms `QUANTA_REQUIRE_CAPABILITIES` in its OWN environment for
 * every id the receipt answered definitely. Workers inherit it through the base
 * env, not the bag, so a dropped bag arrives as a named failure. A receipt that
 * arrives never trips it: for a definite id the worker sees `executed` or
 * `skipped-unsupported`, and only `blocked-missing`/`failed-setup` fire.
 *
 * Two lanes did not go through the runner at all. `test:contract` and
 * `test:real-toolchain` ran plain `bun test`, so every receipt-gated file in
 * them answered `blocked-missing` on every host: green by skipping locally, and
 * red on a provisioned CI runner, whose contract job sets `REQUIRE_CONTRACT=1`.
 * Both now run through `tools/dev/with-capability-receipt.ts`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import ts from "typescript"
import { DEVTOOLS_ENDPOINT_TIMEOUT_DETAIL } from "@/browser"
import {
  capabilityReceiptEnvForCampaign,
  chromeBringUpFailure,
  type ProbeSpawner,
  type SpawnedProbe,
} from "../../../tools/dev/capability-probe-producer"
import {
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_REQUIRE_ENV,
  capabilityRequiredFor,
  definiteCapabilityIds,
  mergeRequiredCapabilities,
} from "../../../tools/dev/capability-receipt"
import { runWithCapabilityReceipt } from "../../../tools/dev/with-capability-receipt"
import { CAMPAIGN_CAPABILITY_ENV, workerSpawnEnv } from "../../../tools/dev/worker-home"
import { contractRequired } from "../../contract/_guard"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const RUNNER = join(REPO_ROOT, "tools", "dev", "run-test-shards.ts")
/** The identifier's NAME in the runner source; the value is the env key. */
const CAPABILITY_REQUIRE_ENV_NAME = "CAPABILITY_REQUIRE_ENV"
/** A real receipt consumer gated on `git`, the one capability every host running this has. */
const CONSUMER = "tests/unit/tool/glob-gitignore-mtime-hellgate.test.ts"

/** This process's env without a campaign's receipt: inside a shard worker it carries one. */
const inheritedWithoutReceipt = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !CAMPAIGN_CAPABILITY_ENV.includes(entry[0]) &&
        entry[0] !== CAPABILITY_REQUIRE_ENV,
    ),
  )

/** Answers by argv, so the arms are about the wiring and not this host's installs. */
const spawner = (
  missing: readonly string[],
  seen: { home: string | undefined }[] = [],
): ProbeSpawner => {
  return (argv, env): SpawnedProbe => {
    seen.push({ home: env.HOME })
    const refused = missing.some((marker) => argv.join(" ").includes(marker))
    return {
      exited: Promise.resolve(refused ? 127 : 0),
      stdout: Promise.resolve(refused ? "" : `${argv[0] ?? "fake"}\n`),
      kill: () => {},
    }
  }
}

describe("which ids a campaign arms, and how an operator's own list survives", () => {
  test("only a DEFINITE answer is armed — a slow or broken probe is not", () => {
    const receipt = {
      capabilities: {
        zeta: { status: "available" },
        alpha: { status: "unavailable" },
        slow: { status: "probe-timeout" },
        broken: { status: "probe-error" },
      },
    }
    // Sorted, both definite statuses, neither indefinite one. Arming `slow`
    // would make a loaded host a red one: its worker answers `failed-setup`
    // whether or not the receipt arrived.
    expect(definiteCapabilityIds(receipt)).toEqual(["alpha", "zeta"])
  })

  test("the switch is widened, never replaced and never narrowed", () => {
    const cases: readonly (readonly [string | undefined, readonly string[], string])[] = [
      [undefined, ["b", "a"], "a,b"],
      ["", ["a"], "a"],
      ["0", ["a"], "a"],
      ["1", ["a"], "1"],
      [" 1 ", ["a"], "1"],
      ["true", ["a"], "1"],
      ["OFF", ["a"], "a"],
      ["z, a ,", ["b", "a"], "a,b,z"],
      ["x", [], "x"],
    ]
    for (const [existing, ids, expected] of cases) {
      expect({ existing, ids, merged: mergeRequiredCapabilities(existing, ids) }).toEqual({
        existing,
        ids,
        merged: expected,
      })
    }
  })

  test("the merged value means what it was built from, to the reader that decides", () => {
    // Composed with the REAL reader, so a merge whose output looks right but uses
    // a separator or a token the reader does not accept is red here.
    const env = { [CAPABILITY_REQUIRE_ENV]: mergeRequiredCapabilities("operator-own", ["git"]) }
    expect(capabilityRequiredFor("git", env)).toBe(true)
    expect(capabilityRequiredFor("operator-own", env)).toBe(true)
    // PAIRED CONTROL: an id nobody armed stays optional. "Everything" would pass
    // the two lines above.
    expect(capabilityRequiredFor("lancedb", env)).toBe(false)
  })
})

describe("the runner arms the switch where a dropped bag cannot take it", () => {
  const source = ts.createSourceFile(
    "run-test-shards.ts",
    readFileSync(RUNNER, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  )

  const nodes = <T extends ts.Node>(pick: (node: ts.Node) => node is T): T[] => {
    const found: T[] = []
    const walk = (node: ts.Node): void => {
      if (pick(node)) found.push(node)
      node.forEachChild(walk)
    }
    walk(source)
    return found
  }
  const isProcessEnv = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  const isSwitchSlot = (node: ts.Node): boolean =>
    ts.isElementAccessExpression(node) &&
    isProcessEnv(node.expression) &&
    ts.isIdentifier(node.argumentExpression) &&
    node.argumentExpression.text === CAPABILITY_REQUIRE_ENV_NAME
  const calleeName = (node: ts.CallExpression): string =>
    ts.isIdentifier(node.expression) ? node.expression.text : ""
  /** The statement of `block` that contains `node`. */
  const statementIndexIn = (block: ts.Block, node: ts.Node): number => {
    let at: ts.Node = node
    while (at.parent !== undefined && at.parent !== block) at = at.parent
    return at.parent === block ? block.statements.indexOf(at as ts.Statement) : -1
  }

  /** `const <owner> = await capabilityReceiptEnvForCampaign(…)` */
  const producesReceipt = (statement: ts.Statement, owner: string): boolean =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === owner &&
        declaration.initializer !== undefined &&
        ts.isAwaitExpression(declaration.initializer) &&
        ts.isCallExpression(declaration.initializer.expression) &&
        calleeName(declaration.initializer.expression) === "capabilityReceiptEnvForCampaign",
    )

  /** The one write to the switch, its shape checked; returns it and the receipt's binding. */
  const armingAssignment = (): { assignment: ts.BinaryExpression; owner: string } => {
    const assignments = nodes(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isSwitchSlot(node.left),
    )
    // ANTI-VACUITY: exactly one. Zero is the mutant that never arms; two means a
    // later write could reset what the first armed.
    expect(assignments).toHaveLength(1)
    const [assignment] = assignments
    if (assignment === undefined) throw new Error("unreachable")
    const merge = assignment.right
    if (!ts.isCallExpression(merge)) throw new Error("the switch is not assigned a call")
    expect(calleeName(merge)).toBe("mergeRequiredCapabilities")
    const [operator, ids] = merge.arguments
    // Merged WITH the operator's value, read from the same slot.
    expect(operator !== undefined && isSwitchSlot(operator)).toBe(true)
    if (ids === undefined || !ts.isCallExpression(ids)) throw new Error("ids are not computed")
    expect(calleeName(ids)).toBe("definiteCapabilityIds")
    const receipt = ids.arguments[0]
    if (receipt === undefined || !ts.isPropertyAccessExpression(receipt)) {
      throw new Error("definiteCapabilityIds is not given a receipt property")
    }
    expect(receipt.name.text).toBe("receipt")
    if (!ts.isIdentifier(receipt.expression)) throw new Error("receipt owner is not a binding")
    return { assignment, owner: receipt.expression.text }
  }

  test("process.env gets the merge of the operator's value and the receipt's definite ids", () => {
    const { assignment, owner } = armingAssignment()
    // The owner is THIS campaign's freshly produced receipt, bound in the same
    // block, before the assignment.
    const block = assignment.parent.parent
    if (!ts.isBlock(block)) throw new Error("the assignment is not a statement of a block")
    const production = block.statements.findIndex((statement) => producesReceipt(statement, owner))
    const armed = statementIndexIn(block, assignment)
    expect(production).toBeGreaterThanOrEqual(0)
    expect(armed).toBeGreaterThan(production)

    // ...and BEFORE both things that read the environment: the cache identity,
    // which must describe the armed run, and the chunk execution that spawns.
    for (const reader of ["testEnvironmentSha256", "executeChunksWithSourcePostflight"]) {
      const calls = nodes(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && calleeName(node) === reader,
      ).filter((call) => statementIndexIn(block, call) >= 0)
      expect({ reader, count: calls.length }).toEqual({ reader, count: 1 })
      expect(statementIndexIn(block, calls[0] as ts.CallExpression)).toBeGreaterThan(armed)
    }
  })

  test("the runner probes under a worker-shaped HOME and compares against the real one", () => {
    // Workers run under a fresh HOME, so a probe under the runner's own HOME
    // answered for a process that does not exist. An audit dropped
    // `HOME: probeHome` and every arm stayed green.
    const calls = nodes(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && calleeName(node) === "capabilityReceiptEnvForCampaign",
    )
    expect(calls).toHaveLength(1)
    const options = calls[0]?.arguments[0]
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      throw new Error("capabilityReceiptEnvForCampaign is not given an object literal")
    }
    const property = (name: string): ts.Expression | undefined => {
      const found = options.properties.find(
        (one): one is ts.PropertyAssignment =>
          ts.isPropertyAssignment(one) && ts.isIdentifier(one.name) && one.name.text === name,
      )
      return found?.initializer
    }
    const probeEnv = property("probeEnv")
    if (probeEnv === undefined || !ts.isObjectLiteralExpression(probeEnv)) {
      throw new Error("probeEnv is not an object literal")
    }
    const home = probeEnv.properties.find(
      (one): one is ts.PropertyAssignment =>
        ts.isPropertyAssignment(one) && ts.isIdentifier(one.name) && one.name.text === "HOME",
    )
    expect(home?.initializer.getText(source)).toBe("probeHome")
    // HOME is the LAST property, so the spread before it cannot override it.
    expect(probeEnv.properties.at(-1)).toBe(home)
    expect(property("hostHome")?.getText(source)).toBe("userInfo().homedir")
    const probeHome = nodes(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "probeHome",
    )
    expect(probeHome).toHaveLength(1)
    expect(probeHome[0]?.initializer?.getText(source)).toMatch(/^join\(runRoot, /u)
  })

  test("the runner removes the receipt it produced, on every exit", () => {
    // Named per process, so a runner that kept its receipt left one per campaign
    // in the shared cache — an audit counted seven from one day.
    const assigned = nodes(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(source) === "capabilityReceiptPath",
    )
    expect(assigned.map((node) => node.right.getText(source))).toEqual(["capability.path"])
    const finallies = nodes((node): node is ts.TryStatement => ts.isTryStatement(node)).filter(
      (one) => one.finallyBlock?.getText(source).includes("lease?.release()") === true,
    )
    expect(finallies.length).toBeGreaterThan(0)
    const body = finallies.at(-1)?.finallyBlock?.getText(source) ?? ""
    const removal = body.indexOf("rmSync(capabilityReceiptPath")
    expect(removal).toBeGreaterThan(0)
    expect(body.lastIndexOf("lease?.release()")).toBeGreaterThan(removal)
  })

  test("nothing else in the runner touches the switch", () => {
    const references = nodes(
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) && node.text === CAPABILITY_REQUIRE_ENV_NAME,
    )
    // The import, the assignment target, the operator's value. A fourth is a
    // `delete`, a reset, or a second writer.
    expect(references).toHaveLength(3)
    const literals = nodes(
      (node): node is ts.StringLiteral =>
        ts.isStringLiteralLike(node) && node.text === CAPABILITY_REQUIRE_ENV,
    )
    expect(literals).toHaveLength(0)
  })

  test("a worker's base env is read from process.env at spawn time, not snapshotted", () => {
    const declarations = nodes(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "workerEnv",
    )
    expect(declarations).toHaveLength(1)
    const [declaration] = declarations
    const initializer = declaration?.initializer
    if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
      throw new Error("workerEnv is not an object literal")
    }
    expect(
      initializer.properties.some(
        (property) => ts.isSpreadAssignment(property) && isProcessEnv(property.expression),
      ),
    ).toBe(true)
    // Inside a function: a module-scope copy would be taken before `main` arms.
    let at: ts.Node | undefined = declaration
    let insideFunction = false
    while (at !== undefined) {
      if (ts.isFunctionLike(at)) insideFunction = true
      at = at.parent
    }
    expect(insideFunction).toBe(true)
  })

  test("the composition carries the switch while the bag is dropped", () => {
    // The pure half of the chain: `workerSpawnEnv` strips the RECEIPT variables
    // from its base, and a rule that stripped the switch with them would drop the
    // one thing that makes a dropped bag loud.
    const base = { PATH: "/usr/bin", [CAPABILITY_REQUIRE_ENV]: "git,lancedb" }
    const env = workerSpawnEnv({
      base,
      capabilityEnv: {},
      workerHome: "/run/w/home",
      workerTmp: "/run/w/tmp",
      repoRoot: "/repo",
      quantaHome: "/run/w/home/.quanta",
      prefsHome: "/run/w/prefs",
      benchResults: "/run/w/bench",
      scanReachSink: "/run/w/scan.jsonl",
      testTimeoutMs: 120_000,
    })
    expect(env[CAPABILITY_REQUIRE_ENV]).toBe("git,lancedb")
    expect(env[CAPABILITY_RECEIPT_PATH_ENV]).toBeUndefined()
  })

  test("CHAIN — produced receipt, armed switch, DROPPED bag: a named failure in a real run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switch-chain-"))
    try {
      const produced = await capabilityReceiptEnvForCampaign({
        repoRoot: REPO_ROOT,
        tier: "pr",
        head: "c".repeat(40),
        outPath: join(dir, "receipt.json"),
        probeEnv: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") },
        spawn: spawner([]),
        includeChrome: false,
        totalDeadlineMs: 10_000,
      })
      const armed = mergeRequiredCapabilities(undefined, definiteCapabilityIds(produced.receipt))
      // PRECONDITION: the consumer's capability is among the armed ids.
      expect(armed.split(",")).toContain("git")
      const env = workerSpawnEnv({
        base: { ...inheritedWithoutReceipt(), [CAPABILITY_REQUIRE_ENV]: armed },
        // The dropped hop.
        capabilityEnv: {},
        workerHome: join(dir, "home"),
        workerTmp: tmpdir(),
        repoRoot: REPO_ROOT,
        quantaHome: join(dir, "home", ".quanta"),
        prefsHome: join(dir, "prefs"),
        benchResults: join(dir, "bench"),
        scanReachSink: join(dir, "scan.jsonl"),
        testTimeoutMs: 120_000,
      })
      const result = Bun.spawnSync([process.execPath, "test", CONSUMER], {
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const out = `${result.stdout.toString()}${result.stderr.toString()}`
      expect(out).toContain("verdict=blocked-missing")
      expect(out).toContain("REQUIRED git is blocked-missing")
      expect(out).toMatch(/\b1 fail\b/)
      expect(result.exitCode).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})

describe("a lane outside the runner gets a receipt, under its own environment", () => {
  const report = [
    "const fs = require('node:fs');",
    "const path = process.env.QUANTA_CAPABILITY_RECEIPT;",
    "console.log(JSON.stringify({",
    "  path, exists: path !== undefined && fs.existsSync(path),",
    "  receipt: path !== undefined && fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null,",
    "  binding: process.env.QUANTA_CAPABILITY_BINDING,",
    "  verdicts: process.env.QUANTA_CAPABILITY_VERDICTS,",
    "  require: process.env.QUANTA_REQUIRE_CAPABILITIES,",
    "  home: process.env.HOME,",
    "}))",
  ].join("\n")

  test("the child gets a live receipt, the merged switch, and the HOME the probes ran under", async () => {
    const probes: { home: string | undefined }[] = []
    let stdout = ""
    const callerHome = "/nonexistent-caller-home"
    const code = await runWithCapabilityReceipt({
      lane: "arm-live",
      cmd: [process.execPath, "-e", report],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: callerHome,
        [CAPABILITY_REQUIRE_ENV]: "operator-own",
        // A stale receipt in the caller's shell must not reach the child.
        [CAPABILITY_RECEIPT_PATH_ENV]: "/stale/receipt.json",
      },
      spawn: spawner(["lancedb"], probes),
      hostHome: "/nonexistent-real-home",
      onStdout: (text) => {
        stdout += text
      },
    })
    expect(code).toBe(0)
    const line = stdout.split("\n").find((one) => one.startsWith("{"))
    if (line === undefined) throw new Error(`child printed no report: ${stdout}`)
    const seen = JSON.parse(line) as {
      path: string
      exists: boolean
      receipt: { capabilities: Record<string, { status: string }> } | null
      binding?: string
      verdicts?: string
      require: string
      home: string
    }
    expect(seen.path).not.toBe("/stale/receipt.json")
    expect(seen.exists).toBe(true)
    expect(seen.binding).toMatch(/^[0-9a-f]{64}$/)
    expect(seen.verdicts).toMatch(/^[0-9a-f]{64}$/)
    if (seen.receipt === null) throw new Error("unreachable")
    // The switch is exactly the merge over what the child's receipt says.
    const definite = definiteCapabilityIds(seen.receipt)
    expect(definite.length).toBeGreaterThan(3)
    expect(seen.receipt.capabilities.lancedb?.status).toBe("unavailable")
    expect(seen.require).toBe(mergeRequiredCapabilities("operator-own", definite))
    expect(seen.require.split(",")).toContain("lancedb")
    // One scratch HOME for the probes and the child, never the caller's.
    expect(probes.length).toBeGreaterThan(0)
    // Plus the one re-probe of the unavailable id under the REAL home, which is
    // how a receipt says "the test HOME hides it" instead of "absent".
    expect(new Set(probes.map((probe) => probe.home))).toEqual(
      new Set([seen.home, "/nonexistent-real-home"]),
    )
    expect(seen.home).not.toBe(callerHome)
    expect(seen.home.startsWith(tmpdir())).toBe(true)
    // Gone afterwards: the shared cache is one directory for every worktree.
    expect(existsSync(seen.path)).toBe(false)
    expect(existsSync(seen.home)).toBe(false)
  }, 60_000)

  test("REAL LANE — the HOME a test sees after the preload is the HOME the probes ran under", async () => {
    // The property the arm above cannot see: every `bun test` preload moves a
    // non-scratch HOME to scratch. A wrapper that probed under the caller's HOME
    // passed the arm above and still answered for a HOME no test has — measured,
    // `lancedb` "available" and both Lance contracts dead on a missing numpy.
    const dir = mkdtempSync(join(tmpdir(), "lane-home-"))
    try {
      const fixture = join(dir, "home-report.test.ts")
      writeFileSync(
        fixture,
        'import { test } from "bun:test"\ntest("reports", () => { console.log("LANE_HOME=" + process.env.HOME) })\n',
      )
      const probes: { home: string | undefined }[] = []
      let out = ""
      const code = await runWithCapabilityReceipt({
        lane: "arm-home",
        cmd: [process.execPath, "test", fixture],
        // A HOME the preload does NOT keep, which is what a developer's shell has.
        env: { ...inheritedWithoutReceipt(), HOME: "/nonexistent-caller-home" },
        spawn: spawner([], probes),
        hostHome: "/nonexistent-real-home",
        onStdout: (text) => {
          out += text
        },
        onStderr: (text) => {
          out += text
        },
      })
      expect(code).toBe(0)
      const seen = /LANE_HOME=(\S+)/.exec(out)?.[1]
      if (seen === undefined) throw new Error(`the fixture never reported: ${out}`)
      expect(new Set(probes.map((probe) => probe.home))).toEqual(new Set([seen]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  test("a failing child's exit code comes back, and its receipt is still removed", async () => {
    let stdout = ""
    const code = await runWithCapabilityReceipt({
      lane: "arm-exit",
      cmd: [
        process.execPath,
        "-e",
        "console.log(process.env.QUANTA_CAPABILITY_RECEIPT); process.exit(7)",
      ],
      env: { PATH: process.env.PATH ?? "", HOME: tmpdir() },
      spawn: spawner([]),
      onStdout: (text) => {
        stdout += text
      },
    })
    expect(code).toBe(7)
    const path = stdout.trim().split("\n").at(-1) ?? ""
    expect(path).toMatch(/arm-exit-\d+\.receipt\.json$/)
    expect(existsSync(path)).toBe(false)
  }, 60_000)

  test("REAL LANE — an armed consumer run through the wrapper executes instead of failing", async () => {
    // The paired red is `capability-receipt-wiring`'s armed arm: the same file,
    // the same switch, no receipt, one named failure. Through the wrapper the
    // only difference is the receipt, and the file executes.
    let out = ""
    const code = await runWithCapabilityReceipt({
      lane: "arm-real",
      cmd: [process.execPath, "test", CONSUMER],
      env: inheritedWithoutReceipt(),
      spawn: spawner([]),
      onStdout: (text) => {
        out += text
      },
      onStderr: (text) => {
        out += text
      },
    })
    expect(out).toContain("capability=git verdict=executed")
    expect(out).not.toContain("REQUIRED git")
    expect(code).toBe(0)
  }, 90_000)

  test("both package lanes run `bun test` only through the wrapper", () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
    ).scripts
    const lanes = { "test:contract": "contract", "test:real-toolchain": "toolchain" } as const
    for (const [script, lane] of Object.entries(lanes)) {
      const command = scripts[script]
      if (command === undefined) throw new Error(`${script} is gone`)
      const running = command
        .split("&&")
        .map((segment) => segment.trim())
        .filter((segment) => /\bbun test\b/.test(segment))
      // One `bun test`, and it is the wrapper's argument, not a sibling of it.
      expect({ script, count: running.length }).toEqual({ script, count: 1 })
      expect(running[0]).toMatch(
        new RegExp(
          `^(?:[A-Z0-9_]+=\\S+ )*bun run tools/dev/with-capability-receipt\\.ts --lane=${lane} -- bun test `,
        ),
      )
    }
  })
})

describe("the contract guard fails as a test, and its switch has the capability grammar", () => {
  test("unset, empty, 0, false, no and off are off; anything else is on", () => {
    const table = [undefined, "", "0", " 0 ", "false", "Off", "1", "true", "yes"].map((value) => [
      value,
      contractRequired(value),
    ])
    expect(table).toEqual([
      [undefined, false],
      ["", false],
      ["0", false],
      [" 0 ", false],
      ["false", false],
      ["Off", false],
      ["1", true],
      ["true", true],
      ["yes", true],
    ])
    // ONE grammar: the capability switch reads `true` as "everything", not as a
    // capability named "true".
    expect(capabilityRequiredFor("git", { [CAPABILITY_REQUIRE_ENV]: "true" })).toBe(true)
    expect(capabilityRequiredFor("git", { [CAPABILITY_REQUIRE_ENV]: "off" })).toBe(false)
  })

  const runFixture = (
    body: string,
    requireContract: string,
  ): { out: string; code: number; junit: string | null } => {
    const dir = mkdtempSync(join(tmpdir(), "contract-guard-"))
    try {
      const file = join(dir, "guarded.test.ts")
      const guard = join(REPO_ROOT, "tests", "contract", "_guard")
      writeFileSync(
        file,
        `import { expect, test } from "bun:test"\nimport { requireContract } from ${JSON.stringify(guard)}\n${body}\n`,
      )
      const junit = join(dir, "junit.xml")
      const result = Bun.spawnSync(
        [
          process.execPath,
          "test",
          file,
          "--parallel=1",
          "--reporter=junit",
          `--reporter-outfile=${junit}`,
        ],
        {
          cwd: REPO_ROOT,
          env: { ...inheritedWithoutReceipt(), REQUIRE_CONTRACT: requireContract },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      return {
        out: `${result.stdout.toString()}${result.stderr.toString()}`,
        code: result.exitCode ?? -1,
        junit: existsSync(junit) ? readFileSync(junit, "utf8") : null,
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const MODULE_SCOPE = [
    'const ok = requireContract("fixture-dep", false)',
    'test.skipIf(!ok)("needs the dep", () => { expect(ok).toBe(true) })',
    'test("an unrelated case in the same file", () => { expect(1).toBe(1) })',
  ].join("\n")

  test("REQUIRED and absent: one named failure, the file's other case still runs, junit written", () => {
    const run = runFixture(MODULE_SCOPE, "1")
    expect(run.out).toContain("(fail) [contract] REQUIRED fixture-dep is unavailable")
    // A module-scope throw — the previous form — MEASURED 0 pass here: the
    // registry is discarded with the module, so the unrelated case is lost.
    expect(run.out).toMatch(/\b1 pass\b/)
    expect(run.out).toMatch(/\b1 fail\b/)
    expect(run.out).toMatch(/\b1 skip\b/)
    expect(run.code).not.toBe(0)
    expect(run.junit).toContain("REQUIRED fixture-dep is unavailable")
  }, 60_000)

  test("PAIRED CONTROL — REQUIRE_CONTRACT=0 skips, says so, and is green", () => {
    const run = runFixture(MODULE_SCOPE, "0")
    expect(run.out).toContain('[contract] skipping "fixture-dep"')
    expect(run.out).not.toContain("REQUIRED fixture-dep")
    expect(run.out).toMatch(/\b1 skip\b/)
    expect(run.code).toBe(0)
  }, 60_000)

  test("called from inside a running test, where nothing can register, it throws there", () => {
    const run = runFixture(
      'test("asks too late", () => { requireContract("late-dep", false) })',
      "1",
    )
    expect(run.out).toContain("(fail) asks too late")
    expect(run.out).toContain('"late-dep" is unavailable but REQUIRE_CONTRACT is set')
    expect(run.code).not.toBe(0)
  }, 60_000)
})

describe("what the receipt says about a capability the tests cannot reach", () => {
  test("unavailable under the test HOME and present under the real one is SAID, not changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hidden-by-home-"))
    try {
      const realHome = join(dir, "real-home")
      // cargo answers only under the real HOME (a rustup proxy under ~/.cargo);
      // node is absent under both.
      const byHome: ProbeSpawner = (argv, env): SpawnedProbe => {
        // By program name: "cargo" contains "go", and a substring test refused both.
        const program = (argv[0] ?? "").split("/").at(-1) ?? ""
        const refused = program === "node" || (program === "cargo" && env.HOME !== realHome)
        return {
          exited: Promise.resolve(refused ? 127 : 0),
          stdout: Promise.resolve(refused ? "" : `${argv[0] ?? "fake"}\n`),
          kill: () => {},
        }
      }
      const produced = await capabilityReceiptEnvForCampaign({
        repoRoot: REPO_ROOT,
        tier: "pr",
        head: "e".repeat(40),
        outPath: join(dir, "receipt.json"),
        probeEnv: { PATH: process.env.PATH ?? "", HOME: join(dir, "scratch-home") },
        spawn: byHome,
        includeChrome: false,
        totalDeadlineMs: 10_000,
        hostHome: realHome,
      })
      const cargo = produced.receipt.capabilities.cargo
      const node = produced.receipt.capabilities.node
      expect(cargo?.status).toBe("unavailable")
      expect(cargo?.detail).toContain(`AVAILABLE under the real HOME ${realHome}`)
      // PAIRED CONTROL: absent everywhere is just absent.
      expect(node?.status).toBe("unavailable")
      expect(node?.detail).not.toContain("AVAILABLE under the real HOME")
      // The file the workers read carries the same words, and the verdict digest
      // (which only statuses move) is the digest of what was written.
      const written = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")) as {
        capabilities: Record<string, { detail: string }>
      }
      expect(written.capabilities.cargo?.detail).toContain("AVAILABLE under the real HOME")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a Chrome that ran out of time is probe-timeout; one that refused is unavailable", () => {
    const context = {
      binary: "chromium",
      probeMs: 15_000,
      endpointTimeoutDetail: DEVTOOLS_ENDPOINT_TIMEOUT_DETAIL,
    }
    expect(
      chromeBringUpFailure(
        { kind: "spawn-failed", detail: DEVTOOLS_ENDPOINT_TIMEOUT_DETAIL },
        context,
      ).status,
    ).toBe("probe-timeout")
    expect(chromeBringUpFailure({ kind: "timeout" }, context).status).toBe("probe-timeout")
    // PAIRED CONTROL: a bring-up that failed for any other reason is a refusal,
    // and keeps the binary so the fail-loud arm still sees "present".
    const refused = chromeBringUpFailure(
      { kind: "spawn-failed", detail: "Target.createTarget failed during bring-up" },
      context,
    )
    expect(refused).toMatchObject({ status: "unavailable", resolved: "chromium" })
  })
})
