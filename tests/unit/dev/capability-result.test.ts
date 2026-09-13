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
    const xml = junit(
      `<testcase name="a" file="f.test.ts"><failure message="boom"/></testcase>` +
        `<testcase name="b" file="f.test.ts"/>`,
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
        `<testcase name="c" file="h.test.ts"><failure message="boom"/></testcase>`,
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
