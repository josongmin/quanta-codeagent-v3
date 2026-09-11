/**
 * TVH-06 P0 — the required verdict names its producers.
 *
 * MEASURED DEFECT (HEAD 85a99bb6f). `aggregateRequiredNeeds` checked that the
 * needs object was non-empty and that every row it was HANDED had an
 * acceptable conclusion. It knew nothing about which producers were supposed
 * to exist, so:
 *
 *   QUANTA_REQUIRED_NEEDS='{"static-code":{"result":"success"}}'  → PASS
 *
 * i.e. deleting a producer job together with its `needs:` entry deleted six
 * sevenths of the required coverage AND the evidence of the deletion in one
 * commit. Everything below is a red-on-injection case against that.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CAPABILITY_RESULT_SCHEMA,
  type CapabilityResult,
  capabilityProducers,
  parseWorkflowJobGraph,
  REQUIRED_WORKFLOW_PATH,
  type RequiredProducer,
  requiredProducerIds,
  requiredProducers,
  validateCapabilityResult,
} from "../../../tools/dev/verification-required-producers"
import {
  aggregateRequiredNeeds,
  readCapabilityResults,
} from "../../../tools/dev/verification-required-results"

const REPO_ROOT = join(import.meta.dir, "../../..")
const REAL_WORKFLOW = readFileSync(join(REPO_ROOT, REQUIRED_WORKFLOW_PATH), "utf8")

/** The exact set, written out by hand. Emptying or trimming the SSOT is RED
 *  here — the anti-vacuum floor for every comparison in this file. */
const EXPECTED_IDS = [
  "static-code",
  "catalog",
  "full-suite",
  "pty",
  "web",
  "toolchain",
  "contract",
] as const

const greenNeeds = (
  ids: readonly string[] = EXPECTED_IDS,
): Record<string, { readonly result: string }> =>
  Object.fromEntries(ids.map((id) => [id, { result: "success" }]))

const executedArtifact = (producer: string): CapabilityResult => ({
  schema: CAPABILITY_RESULT_SCHEMA,
  producer,
  executedFiles: [`tests/${producer}/one.test.ts`],
  executedCases: 8,
  skippedUnsupported: 0,
  blockedMissing: 0,
  failedSetup: 0,
})

const greenCapabilities = (): Record<string, unknown> =>
  Object.fromEntries(
    capabilityProducers().map((producer) => [producer.id, executedArtifact(producer.id)]),
  )

const syntheticWorkflow = (
  jobIds: readonly string[] = EXPECTED_IDS,
  declaredNeeds: readonly string[] = jobIds,
): string =>
  [
    "name: ci",
    "jobs:",
    ...jobIds.map(
      (id) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${id}`,
    ),
    "  required:",
    `    needs: [${declaredNeeds.join(", ")}]`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo required",
  ].join("\n")

const reasonsOf = (verdict: ReturnType<typeof aggregateRequiredNeeds>): readonly string[] =>
  verdict.ok ? [] : verdict.reasons

describe("required producer SSOT is exact and non-empty", () => {
  test("the expected set has exact, asserted membership", () => {
    // Anti-vacuum: if the SSOT is emptied, trimmed or padded, this is RED
    // before any of the comparison tests below become trivially satisfiable.
    expect(requiredProducerIds()).toEqual([...EXPECTED_IDS])
    expect(requiredProducerIds().length).toBeGreaterThan(0)
    expect(capabilityProducers().map((producer) => producer.id)).toEqual([
      "pty",
      "toolchain",
      "contract",
    ])
    for (const producer of capabilityProducers()) {
      expect(producer.capability?.minimumExecutedCases ?? 0).toBeGreaterThan(0)
      expect(producer.capability?.minimumExecutedFiles ?? 0).toBeGreaterThan(0)
    }
  })

  test("an empty SSOT fails closed instead of vacuously passing", () => {
    const verdict = aggregateRequiredNeeds({
      needs: greenNeeds(),
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
      producers: [],
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toEqual(["expected producer set is empty"])
  })

  test("the SSOT agrees with the REAL workflow's required job", () => {
    const graph = parseWorkflowJobGraph(REAL_WORKFLOW)
    expect(graph.needsByJob.required).toEqual([...EXPECTED_IDS])
    for (const producer of requiredProducers()) {
      expect(graph.jobIds, producer.job).toContain(producer.job)
      expect(producer.workflow).toBe(REQUIRED_WORKFLOW_PATH)
    }
  })

  test("a fully green, fully populated run passes", () => {
    expect(
      aggregateRequiredNeeds({
        needs: greenNeeds(),
        workflowYaml: REAL_WORKFLOW,
        capabilityResults: greenCapabilities(),
      }),
    ).toEqual({ ok: true })
  })
})

describe("three-way producer comparison", () => {
  test("[1] a deleted needs key is RED, naming that exact id", () => {
    for (const dropped of EXPECTED_IDS) {
      const verdict = aggregateRequiredNeeds({
        needs: greenNeeds(EXPECTED_IDS.filter((id) => id !== dropped)),
        workflowYaml: REAL_WORKFLOW,
        capabilityResults: greenCapabilities(),
      })
      expect(verdict.ok, dropped).toBe(false)
      expect(reasonsOf(verdict), dropped).toContain(`missing producer ids in needs: ${dropped}`)
    }
  })

  test("the historical one-row bypass is RED", () => {
    // The literal payload that used to PASS.
    const verdict = aggregateRequiredNeeds({
      needs: JSON.parse('{"static-code":{"result":"success"}}') as Record<
        string,
        { readonly result?: unknown }
      >,
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain(
      "missing producer ids in needs: catalog, contract, full-suite, pty, toolchain, web",
    )
  })

  test("[2] an unknown needs key is RED, naming that exact id", () => {
    const verdict = aggregateRequiredNeeds({
      needs: { ...greenNeeds(), "rogue-producer": { result: "success" } },
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain("unknown producer ids in needs: rogue-producer")
  })

  test("[3] a deleted `needs:` entry in the workflow is RED, naming that exact id", () => {
    for (const dropped of EXPECTED_IDS) {
      const verdict = aggregateRequiredNeeds({
        // Rows still all green, key set still complete — ONLY the workflow's
        // declaration lost the edge. A count-based reducer sees nothing.
        needs: greenNeeds(),
        workflowYaml: syntheticWorkflow(
          EXPECTED_IDS,
          EXPECTED_IDS.filter((id) => id !== dropped),
        ),
        capabilityResults: greenCapabilities(),
      })
      expect(verdict.ok, dropped).toBe(false)
      expect(reasonsOf(verdict), dropped).toContain(
        `workflow "required" job does not declare needs for producer ids: ${dropped}`,
      )
    }
  })

  test("deleting the producer JOB and its needs entry together is RED", () => {
    // The exact commit shape the defect allowed: job gone, edge gone, and the
    // six surviving rows all green.
    const survivors = EXPECTED_IDS.filter((id) => id !== "contract")
    const verdict = aggregateRequiredNeeds({
      needs: greenNeeds(survivors),
      workflowYaml: syntheticWorkflow(survivors, survivors),
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain("missing producer ids in needs: contract")
    expect(reasonsOf(verdict)).toContain(
      'workflow "required" job does not declare needs for producer ids: contract',
    )
    expect(reasonsOf(verdict)).toContain(
      `${REQUIRED_WORKFLOW_PATH} has no job for required producer ids: contract`,
    )
  })

  test("a workflow needs-edge the SSOT does not know is RED", () => {
    const verdict = aggregateRequiredNeeds({
      needs: greenNeeds(),
      workflowYaml: syntheticWorkflow([...EXPECTED_IDS, "smuggled"], [...EXPECTED_IDS, "smuggled"]),
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain(
      'workflow "required" job declares needs not in the required SSOT: smuggled',
    )
  })

  test("a workflow with no aggregator job at all is RED", () => {
    const verdict = aggregateRequiredNeeds({
      needs: greenNeeds(),
      workflowYaml: "name: ci\njobs:\n  static-code:\n    runs-on: ubuntu-latest\n",
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain('workflow has no "required" job')
  })

  test("parseWorkflowJobGraph reads both the list and scalar spellings of needs", () => {
    expect(
      parseWorkflowJobGraph("jobs:\n  a:\n    runs-on: x\n  b:\n    needs: a\n").needsByJob,
    ).toEqual({ a: [], b: ["a"] })
    expect(parseWorkflowJobGraph("jobs:\n  b:\n    needs: [a, c]\n").needsByJob.b).toEqual([
      "a",
      "c",
    ])
    expect(parseWorkflowJobGraph("not: a workflow\n")).toEqual({ jobIds: [], needsByJob: {} })
  })
})

describe("row conclusions", () => {
  test("[6] every row skipped under a success-shaped envelope is RED", () => {
    const verdict = aggregateRequiredNeeds({
      needs: Object.fromEntries(EXPECTED_IDS.map((id) => [id, { result: "skipped" }])),
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain('every producer row is "skipped" — nothing executed')
  })

  test("all-skipped is RED even when the policy argument would excuse a skip", () => {
    // `policy: "not-selected"` makes requiredCheckOutcome accept a skip row by
    // row. A run where NOTHING executed is still not a pass.
    const verdict = aggregateRequiredNeeds({
      needs: Object.fromEntries(EXPECTED_IDS.map((id) => [id, { result: "skipped" }])),
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
      policy: "not-selected",
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain('every producer row is "skipped" — nothing executed')
  })

  test("one failed or skipped row is RED, naming it", () => {
    for (const [conclusion, id] of [
      ["skipped", "contract"],
      ["failure", "full-suite"],
      ["cancelled", "pty"],
      ["neutral", "web"],
    ] as const) {
      const verdict = aggregateRequiredNeeds({
        needs: { ...greenNeeds(), [id]: { result: conclusion } },
        workflowYaml: REAL_WORKFLOW,
        capabilityResults: greenCapabilities(),
      })
      expect(verdict.ok, id).toBe(false)
      expect(reasonsOf(verdict), id).toContain(`producer "${id}" concluded "${conclusion}"`)
    }
  })

  test("a non-conclusion result is RED rather than coerced", () => {
    const verdict = aggregateRequiredNeeds({
      needs: { ...greenNeeds(), catalog: { result: "SUCCESS" } },
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: greenCapabilities(),
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain(
      'producer "catalog" has a non-conclusion result: "SUCCESS"',
    )
  })
})

describe("capability zero-execution floor", () => {
  const pty = requiredProducers().find(
    (producer) => producer.id === "pty",
  ) as unknown as RequiredProducer

  test("[4] a success-shaped artifact with 0 executed cases is RED", () => {
    const verdict = aggregateRequiredNeeds({
      needs: greenNeeds(),
      workflowYaml: REAL_WORKFLOW,
      capabilityResults: {
        ...greenCapabilities(),
        pty: {
          ...executedArtifact("pty"),
          executedFiles: [],
          executedCases: 0,
          skippedUnsupported: 8,
        },
      },
    })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toContain('capability producer "pty" executed 0 case(s), floor is 1')
  })

  test("[5] an absent capability artifact is RED, not PASS", () => {
    for (const producer of capabilityProducers()) {
      const capabilityResults = { ...greenCapabilities() }
      delete capabilityResults[producer.id]
      const verdict = aggregateRequiredNeeds({
        needs: greenNeeds(),
        workflowYaml: REAL_WORKFLOW,
        capabilityResults,
      })
      expect(verdict.ok, producer.id).toBe(false)
      expect(reasonsOf(verdict), producer.id).toContain(
        `capability artifact absent for producer "${producer.id}"`,
      )
    }
  })

  test("no capability artifacts at all is RED for every capability producer", () => {
    const verdict = aggregateRequiredNeeds({ needs: greenNeeds(), workflowYaml: REAL_WORKFLOW })
    expect(verdict.ok).toBe(false)
    expect(reasonsOf(verdict)).toEqual([
      'capability artifact absent for producer "pty"',
      'capability artifact absent for producer "toolchain"',
      'capability artifact absent for producer "contract"',
    ])
  })

  test("blocked-missing and failed-setup are failures, not skips", () => {
    expect(
      validateCapabilityResult(pty, { ...executedArtifact("pty"), blockedMissing: 3 }),
    ).toEqual({
      ok: false,
      reason: 'capability producer "pty" reports 3 blocked-missing dependency(ies)',
    })
    expect(validateCapabilityResult(pty, { ...executedArtifact("pty"), failedSetup: 2 })).toEqual({
      ok: false,
      reason: 'capability producer "pty" reports 2 failed-setup case(s)',
    })
  })

  test("a wrong-schema, wrong-producer or malformed artifact is RED", () => {
    expect(validateCapabilityResult(pty, { ...executedArtifact("pty"), schema: "v0" }).ok).toBe(
      false,
    )
    expect(validateCapabilityResult(pty, { ...executedArtifact("pty"), producer: "web" })).toEqual({
      ok: false,
      reason: 'capability artifact producer mismatch: artifact says "web", expected "pty"',
    })
    expect(
      validateCapabilityResult(pty, { ...executedArtifact("pty"), executedCases: "many" }),
    ).toEqual({
      ok: false,
      reason: 'capability producer "pty" reports malformed executed/skipped counts',
    })
    expect(validateCapabilityResult(pty, [executedArtifact("pty")]).ok).toBe(false)
  })

  test("a non-capability producer needs no artifact", () => {
    const staticCode = requiredProducers().find(
      (producer) => producer.id === "static-code",
    ) as unknown as RequiredProducer
    expect(staticCode.capability).toBeUndefined()
    expect(validateCapabilityResult(staticCode, undefined)).toEqual({ ok: true })
  })

  test("readCapabilityResults reports an unreadable file as present-but-null, not absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-capability-"))
    try {
      writeFileSync(join(dir, "pty.json"), JSON.stringify(executedArtifact("pty")))
      writeFileSync(join(dir, "toolchain.json"), "{ truncated")
      const results = readCapabilityResults(dir)
      expect(results.pty).toEqual(executedArtifact("pty"))
      expect(results.toolchain).toBeNull()
      expect(results.contract).toBeUndefined()
      expect(readCapabilityResults(undefined).pty).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the CLI actually consumes the guard (wiring proof)", () => {
  const run = (
    needs: unknown,
    capabilityDir: string | undefined,
  ): { readonly exitCode: number; readonly stderr: string; readonly stdout: string } => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(REPO_ROOT, "tools/dev/verification-required-results.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          QUANTA_REQUIRED_NEEDS: JSON.stringify(needs),
          ...(capabilityDir === undefined ? {} : { QUANTA_CAPABILITY_RESULTS_DIR: capabilityDir }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    }
  }

  test("exit 1 with the offending id on stderr when a producer key is deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-capability-cli-"))
    try {
      for (const producer of capabilityProducers()) {
        writeFileSync(
          join(dir, `${producer.id}.json`),
          JSON.stringify(executedArtifact(producer.id)),
        )
      }
      expect(run(greenNeeds(), dir).exitCode).toBe(0)
      const dropped = run(greenNeeds(EXPECTED_IDS.filter((id) => id !== "contract")), dir)
      expect(dropped.exitCode).toBe(1)
      expect(dropped.stderr).toContain("missing producer ids in needs: contract")
      // …and with no capability artifacts published at all, absent is a FAIL.
      const noArtifacts = run(greenNeeds(), undefined)
      expect(noArtifacts.exitCode).toBe(1)
      expect(noArtifacts.stderr).toContain('capability artifact absent for producer "pty"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
