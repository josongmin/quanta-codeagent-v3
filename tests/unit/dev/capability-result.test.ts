/**
 * The artifact that tells a green capability job from a green capability job
 * that executed nothing.
 *
 * Three producers behind `required` are capability lanes: `pty` (every describe
 * in tests/e2e-pty is `skipIf(!PTY_AVAILABLE)`), `toolchain` (the `*-real-e2e`
 * arms degrade to visible skips without clangd / lldb-dap / dlv / debugpy), and
 * `contract` (docker, language servers, Python + LanceDB). On a runner missing
 * the capability each exits 0 having run nothing, GitHub reports `success`, and
 * no count of green rows can tell that apart from full coverage.
 *
 * Measured end-to-end while building this: a file whose every case is skipped
 * produces `executedCases: 0`, and the required aggregator then exits 1 with
 * `capability producer "pty" executed 0 case(s), floor is 1`.
 */

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import ts from "typescript"
import { capabilityReceiptEnvForCampaign } from "../../../tools/dev/capability-probe-producer"
import {
  type CapabilityFinding,
  capabilityRecordName,
  capabilityRequiredFailureName,
  contractRequiredFailureName,
  mintCapabilityReceipt,
} from "../../../tools/dev/capability-receipt"
import {
  capabilityRecordsFromJunit,
  capabilityResultForMissingJunit,
  capabilityResultFromJunit,
  countJunitExecution,
  describeCapabilityRecords,
} from "../../../tools/dev/capability-result"
import { CAPABILITY_GROUPS } from "../../../tools/dev/test-capability-manifest"
import {
  requiredProducers,
  validateCapabilityResult,
} from "../../../tools/dev/verification-required-producers"
import { CAMPAIGN_CAPABILITY_ENV } from "../../../tools/dev/worker-home"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

const junit = (cases: string): string =>
  `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`

describe("capability-result", () => {
  test("a skipped case is not executed, and its file does not count", () => {
    const xml = junit(
      `<testcase name="a" file="tests/e2e-pty/x.test.ts"><skipped/></testcase>` +
        `<testcase name="b" file="tests/e2e-pty/x.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedCases: 2,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 0,
    })
  })

  test("a failing case IS executed — it is coverage that found something", () => {
    // `line` as Bun writes it for every real case.
    const xml = junit(
      `<testcase name="a" file="f.test.ts" line="3"><failure message="boom"/></testcase>` +
        `<testcase name="b" file="f.test.ts" line="4"/>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 2,
      executedCasesByFile: { "f.test.ts": 2 },
      skippedCases: 0,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 0,
    })
  })

  test("a failing HOOK is not a case: it is failed-setup, and its file is not executed", () => {
    // Bun's shape for a `beforeAll` throw: `(unnamed)`, a failure, no `line`, and
    // the describe's cases gone. Counted as a case, an npm install that failed in
    // two lane files met the js-test-runner floor of 2 files / 2 cases.
    const xml = junit(
      `<testcase name="(unnamed)" classname="lane" file="f.test.ts"><failure type="AssertionError" /></testcase>` +
        `<testcase name="(unnamed)" classname="lane" file="g.test.ts"><failure type="AssertionError" /></testcase>` +
        // PAIRED CONTROL: a real case named "" still carries `line`.
        `<testcase name="" file="h.test.ts" line="11"><failure type="AssertionError" /></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["h.test.ts"],
      executedCases: 1,
      executedCasesByFile: { "h.test.ts": 1 },
      skippedCases: 0,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 2,
    })
  })

  test("a file with one live case among skips counts once", () => {
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><skipped/></testcase>` +
        `<testcase name="b" file="f.test.ts"/>` +
        `<testcase name="c" file="g.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 1,
      executedCasesByFile: { "f.test.ts": 1 },
      skippedCases: 2,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 0,
    })
  })

  test("self-closing and block forms are both read", () => {
    const xml = junit(
      `<testcase name="a" file="f.test.ts"/><testcase name="b" file="f.test.ts">` +
        `<system-out>noise</system-out></testcase>`,
    )
    expect(countJunitExecution(xml).executedCases).toBe(2)
  })

  test("classname stands in when no file attribute is emitted", () => {
    const xml = junit(`<testcase name="a" classname="pkg.Thing"/>`)
    expect(countJunitExecution(xml).executedFiles).toEqual(["pkg.Thing"])
  })

  test("an all-skipped lane produces the zero-execution artifact", () => {
    const result = capabilityResultFromJunit({
      producer: "pty",
      xml: junit(`<testcase name="a" file="f.test.ts"><skipped/></testcase>`),
    })
    expect(result).toEqual({
      schema: "quanta.capability-result.v2",
      producer: "pty",
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedUnsupported: 1,
      blockedMissing: 0,
      failedSetup: 0,
    })
  })

  test("a missing JUnit is failedSetup, not zero skips", () => {
    // The difference is whether the lane chose not to run or never got the
    // chance. Both fail at the aggregator; only one is a provisioning defect,
    // and publishing nothing at all would read as a lost upload instead.
    const result = capabilityResultForMissingJunit("contract")
    expect(result.failedSetup).toBe(1)
    expect(result.skippedUnsupported).toBe(0)
    expect(result.executedCases).toBe(0)
  })

  test("blocked and setup-failed counts are carried through", () => {
    const result = capabilityResultFromJunit({
      producer: "contract",
      xml: junit(`<testcase name="a" file="f.test.ts"/>`),
      blockedMissing: 2,
      failedSetup: 1,
    })
    expect({ blocked: result.blockedMissing, setup: result.failedSetup }).toEqual({
      blocked: 2,
      setup: 1,
    })
  })

  test("a skip elsewhere in the document does not unexecute a BLOCK-form case", () => {
    // Mutation survivor: `skipped = /<skipped\b/.test(body)` -> `.test(xml)`
    // passed every fixture, because each fixture's EXECUTED case was
    // self-closing and so never entered the body branch at all. That is not the
    // shape a real lane emits — Bun writes `<testcase …>` with children for any
    // case that produced output, beside `<skipped />` siblings for the rest.
    const xml = junit(
      `<testcase name="ran" file="f.test.ts"><system-out>hello</system-out></testcase>` +
        `<testcase name="did not" file="f.test.ts"><skipped/></testcase>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts"],
      executedCases: 1,
      executedCasesByFile: { "f.test.ts": 1 },
      skippedCases: 1,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 0,
    })

    // …and the document-scoped reading really would get this wrong, which is
    // what makes the assertion above load-bearing rather than incidental.
    const documentScoped = /<skipped\b/u.test(xml)
    expect(documentScoped).toBe(true)
  })

  test("the first block-form case is not unexecuted by a LATER skip", () => {
    // Ordering matters for a scan: a document-scoped test also mis-reads the
    // case that comes BEFORE the skip, which is the common layout when a lane
    // runs a few arms and skips the rest.
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><system-out>x</system-out></testcase>` +
        `<testcase name="b" file="g.test.ts"><skipped/></testcase>` +
        `<testcase name="c" file="h.test.ts" line="9"><failure message="boom"/></testcase>`,
    )
    const counts = countJunitExecution(xml)
    expect(counts.executedFiles).toEqual(["f.test.ts", "h.test.ts"])
    expect(counts.executedCases).toBe(2)
    expect(counts.skippedCases).toBe(1)
  })

  test("an empty report is zero, not a crash", () => {
    expect(countJunitExecution(junit(""))).toEqual({
      executedFiles: [],
      executedCases: 0,
      executedCasesByFile: {},
      skippedCases: 0,
      recordedBlockedMissing: 0,
      recordedFailedSetup: 0,
    })
  })
})

describe("a receipt decision that did not execute is a RECORD the artifact counts", () => {
  const xmlAttribute = (text: string): string =>
    // Every entity Bun writes, measured: `&quot;`, `&amp;`, `&lt;`, `&gt;`.
    text
      .replace(/&/gu, "&amp;")
      .replace(/"/gu, "&quot;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
  const record = (file: string, id: string, verdict: string, detail = "why"): string =>
    `<testcase name="${xmlAttribute(capabilityRecordName(id, verdict, detail))}" file="${file}"><skipped /></testcase>`

  test("once per file and capability, never a case, never a skip", () => {
    const xml = junit(
      record("f.test.ts", "git", "blocked-missing") +
        // The same file asking twice is one blocked capability, not two.
        record("f.test.ts", "git", "blocked-missing") +
        record("g.test.ts", "git", "blocked-missing") +
        record("f.test.ts", "chrome-cdp", "failed-setup", 'probe "timed out" & <gave up>') +
        // Absence is not a hard failure, and a record is not a gated case either.
        record("f.test.ts", "lancedb", "skipped-unsupported") +
        `<testcase name="gated" file="f.test.ts"><skipped /></testcase>` +
        `<testcase name="ran" file="f.test.ts"/>` +
        // A case that RAN is a case, whatever it is called.
        `<testcase name="${xmlAttribute(capabilityRecordName("git", "blocked-missing", "x"))}" file="h.test.ts"/>`,
    )
    expect(countJunitExecution(xml)).toEqual({
      executedFiles: ["f.test.ts", "h.test.ts"],
      executedCases: 2,
      executedCasesByFile: { "f.test.ts": 1, "h.test.ts": 1 },
      skippedCases: 1,
      recordedBlockedMissing: 2,
      recordedFailedSetup: 1,
    })
  })

  test("recorded counts are ADDED to the flags, not replaced by them", () => {
    const result = capabilityResultFromJunit({
      producer: "contract",
      xml: junit(
        `${record("f.test.ts", "git", "blocked-missing")}<testcase name="a" file="f.test.ts"/>`,
      ),
      blockedMissing: 1,
      failedSetup: 2,
    })
    expect({ blocked: result.blockedMissing, setup: result.failedSetup }).toEqual({
      blocked: 2,
      setup: 2,
    })
  })

  const runFixture = (env: Record<string, string>): { xml: string; file: string } => {
    // Real path: junit carries `/private/tmp/…` on macOS, where `/tmp` is a link.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capability-record-")))
    try {
      const file = join(dir, "asks.test.ts")
      const consumer = join(REPO_ROOT, "tools", "dev", "capability-receipt-consumer")
      writeFileSync(
        file,
        [
          `import { expect, test } from "bun:test"`,
          `import { canExecute, capability } from ${JSON.stringify(consumer)}`,
          `const git = capability("git")`,
          `test.skipIf(!canExecute(git))("needs git", () => { expect(git.verdict).toBe("executed") })`,
          `test("independent of git", () => { expect(1).toBe(1) })`,
          ``,
        ].join("\n"),
      )
      const junitPath = join(dir, "junit.xml")
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !CAMPAIGN_CAPABILITY_ENV.includes(entry[0]) &&
            entry[0] !== "QUANTA_REQUIRE_CAPABILITIES",
        ),
      )
      Bun.spawnSync(
        [process.execPath, "test", file, "--reporter=junit", `--reporter-outfile=${junitPath}`],
        { cwd: REPO_ROOT, env: { ...inherited, ...env }, stdout: "pipe", stderr: "pipe" },
      )
      if (!existsSync(junitPath)) throw new Error("the fixture wrote no junit")
      return { xml: readFileSync(junitPath, "utf8"), file }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const contract = requiredProducers().find((producer) => producer.id === "contract")

  test("REAL RUN — no receipt: the record is in the asking file, and the aggregator refuses", () => {
    const { xml, file } = runFixture({})
    const result = capabilityResultFromJunit({ producer: "contract", xml })
    expect(result.blockedMissing).toBe(1)
    // The gated case is the only skip; the record is not one.
    expect(result.skippedUnsupported).toBe(1)
    expect(result.executedCasesByFile).toEqual({ [file]: 1 })
    if (contract === undefined) throw new Error("no contract producer")
    const verdict = validateCapabilityResult(contract, result)
    expect(verdict).toEqual({
      ok: false,
      reason: 'capability producer "contract" reports 1 blocked-missing dependency(ies)',
    })
  }, 60_000)

  test("armed, the requirement failure IS the record: counted once, and not as a case", () => {
    const { xml, file } = runFixture({ QUANTA_REQUIRE_CAPABILITIES: "git" })
    expect(xml).toContain("REQUIRED git is blocked-missing")
    expect(xml).not.toContain("RECORD git")
    const result = capabilityResultFromJunit({ producer: "contract", xml })
    // It used to be an EXECUTED case with `blocked=0`: the artifact contradicted
    // the red job it described, and the failure could satisfy an executed floor.
    expect(result.blockedMissing).toBe(1)
    expect(result.executedCasesByFile).toEqual({ [file]: 1 })
  }, 60_000)

  test("PAIRED CONTROL — a receipt that says git runs leaves no record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capability-record-receipt-"))
    try {
      const produced = await capabilityReceiptEnvForCampaign({
        repoRoot: REPO_ROOT,
        tier: "pr",
        head: "d".repeat(40),
        outPath: join(dir, "receipt.json"),
        probeEnv: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") },
        spawn: (argv) => ({
          exited: Promise.resolve(0),
          stdout: Promise.resolve(`${argv[0] ?? "fake"}\n`),
          kill: () => {},
        }),
        includeChrome: false,
        totalDeadlineMs: 10_000,
      })
      const { xml, file } = runFixture({ ...produced.env })
      const result = capabilityResultFromJunit({ producer: "contract", xml })
      expect(result.blockedMissing).toBe(0)
      expect(result.skippedUnsupported).toBe(0)
      expect(result.executedCasesByFile).toEqual({ [file]: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("a REQUIRED failure from either system is a record whether it failed or was filtered", () => {
    const xml = junit(
      `<testcase name="${xmlAttribute(capabilityRequiredFailureName("git", "failed-setup"))}" file="f.test.ts"><failure message="x"/></testcase>` +
        // `-t` turns an unmatched REQUIRED test into a skip; it is still the record.
        `<testcase name="${xmlAttribute(capabilityRequiredFailureName("lancedb", "blocked-missing"))}" file="f.test.ts"><skipped /></testcase>` +
        `<testcase name="${xmlAttribute(contractRequiredFailureName("docker"))}" file="c.test.ts"><failure message="x"/></testcase>` +
        `<testcase name="ran" file="f.test.ts"/>`,
    )
    const counts = countJunitExecution(xml)
    expect({
      executed: counts.executedCases,
      skipped: counts.skippedCases,
      blocked: counts.recordedBlockedMissing,
      setup: counts.recordedFailedSetup,
    }).toEqual({ executed: 1, skipped: 0, blocked: 2, setup: 1 })
    expect(describeCapabilityRecords(capabilityRecordsFromJunit(xml))).toBe(
      "blocked-missing=2 failed-setup=1 skipped-unsupported=0 — blocked-missing docker in c.test.ts; " +
        "blocked-missing lancedb in f.test.ts; failed-setup git in f.test.ts",
    )
  })
})

/**
 * A statement of its block that no earlier `return` or `throw` in that block cuts
 * off. An audit moved the fresh-chunk push below the `return` beside it and the
 * WIRING arm stayed green while fresh chunks fed nothing.
 */
const pushIsReached = (call: ts.CallExpression): boolean => {
  const statement = call.parent
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return false
  const siblings = statement.parent.statements
  const at = siblings.indexOf(statement)
  return siblings
    .slice(0, at)
    .every((earlier) => !ts.isReturnStatement(earlier) && !ts.isThrowStatement(earlier))
}

/** The text a call's object-literal argument gives `name`; a shorthand gives its own name. */
const propertyText = (
  call: ts.CallExpression | undefined,
  name: string,
  tree: ts.SourceFile,
): string | undefined => {
  const bag = call?.arguments[0]
  if (bag === undefined || !ts.isObjectLiteralExpression(bag)) return undefined
  const found = bag.properties.find((one) => one.name?.getText(tree) === name)
  if (found === undefined) return undefined
  if (ts.isShorthandPropertyAssignment(found)) return found.name.text
  return ts.isPropertyAssignment(found) ? found.initializer.getText(tree) : undefined
}

describe("a lane gate that did not execute is a RECORD too", () => {
  const GROUP = CAPABILITY_GROUPS[0]?.id ?? "<no groups>"
  const LANE = join(REPO_ROOT, "tests", "_helpers", "capability-lane")

  /** A real lane file with one absent need, run by a real `bun test` into junit. */
  /** A lane file with one absent need whose NAME spans two lines: its detail does too. */
  const BLOCKED_LANE = [
    `import { test } from "bun:test"`,
    `import { capabilityGate, laneDescribe } from ${JSON.stringify(LANE)}`,
    `const GATE = capabilityGate({ group: ${JSON.stringify(GROUP)}, file: "lane.test.ts", needs: { "tool\\nline-two": false } })`,
    `laneDescribe(GATE)("the lane", () => {`,
    `  test("case one", () => {})`,
    `  test("case two", () => {})`,
    `})`,
    ``,
  ].join("\n")

  /** A lane file, run by a real `bun test` into junit. */
  const runLane = (
    env: Readonly<Record<string, string>>,
    body: string = BLOCKED_LANE,
  ): { readonly code: number; readonly out: string; readonly xml: string } => {
    const dir = mkdtempSync(join(tmpdir(), "lane-record-"))
    try {
      const file = join(dir, "lane.test.ts")
      writeFileSync(file, body)
      const junitPath = join(dir, "junit.xml")
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !CAMPAIGN_CAPABILITY_ENV.includes(entry[0]) &&
            entry[0] !== "QUANTA_REQUIRE_CAPABILITIES" &&
            entry[0] !== "QUANTA_REAL_TOOLCHAIN_E2E",
        ),
      )
      const run = Bun.spawnSync(
        [process.execPath, "test", file, "--reporter=junit", `--reporter-outfile=${junitPath}`],
        { cwd: REPO_ROOT, env: { ...inherited, ...env }, stdout: "pipe", stderr: "pipe" },
      )
      return {
        code: run.exitCode ?? -1,
        out: `${run.stdout.toString()}${run.stderr.toString()}`,
        xml: existsSync(junitPath) ? readFileSync(junitPath, "utf8") : "",
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const tally = (xml: string) => {
    const result = capabilityResultFromJunit({ producer: "toolchain", xml })
    return {
      executedCases: result.executedCases,
      skipped: result.skippedUnsupported,
      blocked: result.blockedMissing,
      setup: result.failedSetup,
    }
  }

  test("REQUIRED and blocked: one named failure, zero executed cases, blocked=1", () => {
    // It threw from `beforeAll`, which Bun writes as `(unnamed)` with a failure:
    // an audit reduced exactly that to `executedCases:1, blockedMissing:0` for a
    // red job.
    const run = runLane({ QUANTA_REAL_TOOLCHAIN_E2E: "1", QUANTA_REQUIRE_CAPABILITIES: GROUP })
    expect(run.code).not.toBe(0)
    expect(run.out).toContain(`[capability] REQUIRED group ${GROUP} is blocked-missing`)
    expect(run.xml).not.toContain("(unnamed)")
    expect(tally(run.xml)).toEqual({ executedCases: 0, skipped: 2, blocked: 1, setup: 0 })
    expect(capabilityRecordsFromJunit(run.xml).map((row) => row.capability)).toEqual([
      `group ${GROUP}`,
    ])
  }, 60_000)

  test("PAIRED CONTROL — optional and blocked: green, the record kept across a newline, and not HARD", () => {
    // The detail names a need spanning two lines. Bun writes a newline in a test
    // name as a leading `&#10;`, which hid the record's prefix (measured).
    const run = runLane({ QUANTA_REAL_TOOLCHAIN_E2E: "1" })
    expect(run.code).toBe(0)
    expect(capabilityRecordsFromJunit(run.xml)).toEqual([
      expect.objectContaining({
        capability: `group ${GROUP}`,
        verdict: "blocked-missing",
        required: false,
      }),
    ])
    // A lane group absent on a host it is not required on is the host's property,
    // not a hard failure: it failed the PR `required` gate for nightly-heavy groups
    // the floors exclude on purpose.
    expect(tally(run.xml)).toEqual({ executedCases: 0, skipped: 2, blocked: 0, setup: 0 })
  }, 60_000)

  test("REAL RUN — a fixture that failed in `beforeAll` is failed-setup, not two executed files", () => {
    const run = runLane(
      { QUANTA_REAL_TOOLCHAIN_E2E: "1" },
      [
        `import { beforeAll, test } from "bun:test"`,
        `import { capabilityGate, capabilitySetupFailed, laneDescribe } from ${JSON.stringify(LANE)}`,
        `const GATE = capabilityGate({ group: ${JSON.stringify(GROUP)}, file: "lane.test.ts", needs: { present: true } })`,
        `laneDescribe(GATE)("the lane", () => {`,
        `  beforeAll(() => capabilitySetupFailed(${JSON.stringify(GROUP)}, "lane.test.ts", "npm install failed"))`,
        `  test("case one", () => {})`,
        `})`,
        ``,
      ].join("\n"),
    )
    expect(run.code).not.toBe(0)
    expect(tally(run.xml)).toEqual({ executedCases: 0, skipped: 0, blocked: 0, setup: 1 })
  }, 60_000)

  test("every lane gate is called at module top level, where its record can register", () => {
    // Inside a hook or a test, registration throws: an optional absence then left
    // no record and a required one became an `(unnamed)` failure.
    const misplaced = (path: string, text: string): readonly string[] => {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const found: string[] = []
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "capabilityGate" &&
          ts.findAncestor(node.parent, ts.isFunctionLike) !== undefined
        ) {
          found.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
          )
        }
        node.forEachChild(visit)
      }
      visit(source)
      return found
    }
    const files = execFileSync("git", ["ls-files", "-z", "tests"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((path) => path.endsWith(".test.ts"))
    const lanes = files.filter((path) =>
      readFileSync(join(REPO_ROOT, path), "utf8").includes("capabilityGate("),
    )
    // ANTI-VACUITY: the lane corpus is still there.
    expect(lanes.length).toBeGreaterThanOrEqual(16)
    expect(
      lanes.flatMap((path) => misplaced(path, readFileSync(join(REPO_ROOT, path), "utf8"))),
    ).toEqual([])
    // RED ON INJECTION.
    expect(
      misplaced(
        "tests/unit/injected.test.ts",
        'beforeAll(() => { capabilityGate({ group: "g", file: "f", needs: {} }) })\n',
      ),
    ).toEqual(["tests/unit/injected.test.ts:1"])
  })

  test("PAIRED CONTROL — an unselected lane under `=1` is a skipped-unsupported record, not a red", () => {
    const run = runLane({ QUANTA_REQUIRE_CAPABILITIES: "1" })
    expect(run.code).toBe(0)
    expect(run.out).not.toContain("REQUIRED group")
    expect(tally(run.xml)).toEqual({ executedCases: 0, skipped: 2, blocked: 0, setup: 0 })
    expect(capabilityRecordsFromJunit(run.xml)).toEqual([
      expect.objectContaining({ capability: `group ${GROUP}`, verdict: "skipped-unsupported" }),
    ])
  }, 60_000)
})

describe("the shard runner reads the records a campaign produces", () => {
  const RUNNER = join(REPO_ROOT, "tools", "dev", "run-test-shards.ts")

  test("WIRING — cached and fresh chunks feed one collector, and it is printed before PASS", () => {
    const source = readFileSync(RUNNER, "utf8")
    const tree = ts.createSourceFile(
      "run-test-shards.ts",
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const pushes: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "push" &&
        node.expression.expression.getText(tree) === "input.capabilityRecords"
      ) {
        pushes.push(node.getText(tree))
        expect({ push: node.getText(tree), reached: pushIsReached(node) }).toEqual({
          push: node.getText(tree),
          reached: true,
        })
      }
      node.forEachChild(walk)
    }
    walk(tree)
    // One push per path: the cache replay reads the receipt's junit, the fresh
    // chunk reads the worker's.
    expect(pushes).toHaveLength(2)
    expect(
      pushes.some((one) => one.includes("capabilityRecordsFromJunit(lookup.receipt.junitXml")),
    ).toBe(true)
    expect(
      pushes.some((one) =>
        one.includes("capabilityRecordsFromJunit(readFileSync(result.junitPath"),
      ),
    ).toBe(true)
    const summary = source.indexOf("describeCapabilityRecords(capabilityRecords)")
    const pass = source.indexOf("`[test:shards] PASS suite=")
    expect(summary).toBeGreaterThan(0)
    expect(pass).toBeGreaterThan(summary)

    // ONE COLLECTOR. The pushes above land in `input.capabilityRecords`; that is
    // only the printed array if the caller hands the printed array in. An audit
    // replaced the argument with `[]` and every assertion above stayed green,
    // with the campaign printing `blocked-missing=0` forever.
    const all = <T extends ts.Node>(pick: (node: ts.Node) => node is T): T[] => {
      const found: T[] = []
      const visit = (node: ts.Node): void => {
        if (pick(node)) found.push(node)
        node.forEachChild(visit)
      }
      visit(tree)
      return found
    }
    const calls = (name: string): ts.CallExpression[] =>
      all(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && node.expression.getText(tree) === name,
      )
    const printed = calls("describeCapabilityRecords")
    expect(printed).toHaveLength(1)
    const collector = printed[0]?.arguments[0]
    if (collector === undefined || !ts.isIdentifier(collector)) {
      throw new Error("the printed records are not a named collector")
    }
    const declarations = all(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText(tree) === collector.text,
    )
    expect(declarations).toHaveLength(1)
    const declared = declarations[0]
    expect(declared?.initializer?.getText(tree)).toBe("[]")
    expect(declared !== undefined && (declared.parent.flags & ts.NodeFlags.Const) !== 0).toBe(true)
    // Handed, as that identifier, to the one execution call.
    const [execution] = calls("executeChunksWithSourcePostflight")
    const handedAs = propertyText(execution, "capabilityRecords", tree)
    expect(handedAs).toBe(collector.text)
    // And passed through unchanged to the function that pushes.
    const [wrapper] = all(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(tree) === "executeChunksWithSourcePostflight",
    )
    const forwarded =
      wrapper === undefined
        ? []
        : calls("executeChunks").filter(
            (call) => call.getStart(tree) >= wrapper.getStart(tree) && call.end <= wrapper.end,
          )
    expect(forwarded.map((call) => call.arguments.map((arg) => arg.getText(tree)))).toEqual([
      ["input"],
    ])
  })

  test("a receipt is a SNAPSHOT: a probe answering after it was minted cannot change it", () => {
    const capabilities: Record<string, CapabilityFinding> = {
      git: { status: "probe-timeout", detail: "slow", probeMs: 1 },
    }
    const receipt = mintCapabilityReceipt({
      tier: "pr",
      binding: {
        head: "a".repeat(40),
        policySha256: "b".repeat(64),
        toolchainSha256: "c".repeat(64),
      },
      capabilities,
      deadlineMs: 1,
    })
    capabilities.git = { status: "available", detail: "late", probeMs: 2 }
    expect(receipt.capabilities.git?.status).toBe("probe-timeout")
  })
})
