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
  type CapabilityGroupFloor,
  type CapabilityResult,
  capabilityFloorFor,
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

/**
 * Every member file of every group this producer must show execution for.
 *
 * The predecessor was a single invented path and `executedCases: 8`, which
 * satisfied the old flat 1-file/1-case floor. It could not satisfy the derived
 * floors, and that is the point: a fixture that passes a real floor has to name
 * the real files, so these tests stop being able to describe a lane that never
 * ran.
 */
const requiredMembers = (producer: string): readonly string[] =>
  capabilityFloorFor(producer).groups.flatMap((group) => [...group.members])

/**
 * Cases distributed so every GROUP clears its own case floor.
 *
 * v1 published only a total, so this fixture could meet the producer total and
 * say nothing about the groups. The per-group case floor is enforced now, and a
 * fixture that spread its cases unevenly would fail it — which is the shape a
 * real lane fails in.
 */
const executedArtifact = (producer: string): CapabilityResult => {
  const floor = capabilityFloorFor(producer)
  const byFile: Record<string, number> = {}
  for (const group of floor.groups) {
    const perMember = Math.max(1, Math.ceil(group.minimumExecutedCases / group.members.length))
    for (const member of group.members) byFile[member] = perMember
  }
  if (Object.keys(byFile).length === 0) {
    byFile[`tests/${producer}/one.test.ts`] = Math.max(1, floor.minimumExecutedCases)
  }
  const executedFiles = Object.keys(byFile)
  return {
    schema: CAPABILITY_RESULT_SCHEMA,
    producer,
    executedFiles,
    // The SUM, not a guess: the validator now refuses a total that does not
    // match the per-file counts, because a total nobody can decompose is the
    // field that let a group hide.
    executedCases: executedFiles.reduce((total, file) => total + (byFile[file] ?? 0), 0),
    executedCasesByFile: byFile,
    skippedUnsupported: 0,
    blockedMissing: 0,
    failedSetup: 0,
  }
}

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
      const floor = capabilityFloorFor(producer.id)
      expect(floor.minimumExecutedCases).toBeGreaterThan(0)
      expect(floor.minimumExecutedFiles).toBeGreaterThan(0)
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
          executedCasesByFile: {},
          skippedUnsupported: 8,
        },
      },
    })
    expect(verdict.ok).toBe(false)
    // The GROUP names itself now: "pty executed 0 of its 8 member files" says
    // what did not happen, where "0 cases, floor is 1" only said that the
    // cheapest possible bar was missed.
    expect(reasonsOf(verdict)).toContain(
      'capability group "pty" (producer "pty") executed 0 of its 8 member file(s), floor is 8',
    )
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
    expect(staticCode.capabilityGated).toBeUndefined()
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

/**
 * `CapabilityFloor` has TWO numbers and only one was exercised.
 *
 * Mutation survivor: deleting the `executedFiles.length < minimumExecutedFiles`
 * branch left the suite 32/32 green, because every fixture that tripped the
 * floor tripped the CASE half. An artifact claiming `executedCases: 5` with
 * `executedFiles: []` therefore passed — a lane that reports cases belonging to
 * no file it names, which is exactly the shape a mis-attributed or fabricated
 * artifact has. Raising the file floor would also have been invisible.
 */
describe("the capability file floor is real, not decoration", () => {
  const producer = capabilityProducers()[0]

  test("cases without files is refused", () => {
    if (producer === undefined) throw new Error("no capability producer to test")
    const verdict = validateCapabilityResult(producer, {
      schema: CAPABILITY_RESULT_SCHEMA,
      producer: producer.id,
      executedFiles: [],
      // ABOVE the case floor on purpose, so the FILE half is what trips. The
      // derived floors made the case check fire first and hid the file check
      // again — the same way the original survivor hid.
      executedCases: 999,
      executedCasesByFile: {},
      skippedUnsupported: 0,
      blockedMissing: 0,
      failedSetup: 0,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    // v2 refuses this one check EARLIER and says something sharper: 999 cases
    // belonging to no file is now a decomposition failure, not a floor failure.
    // The invariant the arm exists for is unchanged — cases with no files is
    // refused — and the reason now names why the number cannot be believed.
    expect(verdict.reason).toMatch(/per-file case counts sum to 0, artifact says 999/)
  })

  test("PAIRED CONTROL — the same artifact with one named file is accepted", () => {
    // Without this arm, "always refuse" satisfies the case above.
    if (producer === undefined) throw new Error("no capability producer to test")
    const members = requiredMembers(producer.id)
    // 999 cases spread over the named files, because the total must now
    // decompose: an artifact whose count belongs to no file it names is exactly
    // what the arm above refuses.
    const perFile = Math.ceil(999 / Math.max(1, members.length))
    const verdict = validateCapabilityResult(producer, {
      schema: CAPABILITY_RESULT_SCHEMA,
      producer: producer.id,
      executedFiles: [...members],
      executedCases: perFile * members.length,
      executedCasesByFile: Object.fromEntries(members.map((member) => [member, perFile])),
      skippedUnsupported: 0,
      blockedMissing: 0,
      failedSetup: 0,
    })
    expect(verdict.ok).toBe(true)
  })

  test("the floors come from the MANIFEST, not from a flat 1 file / 1 case", () => {
    // TVH P0-3. Every capability producer used to carry the same 1/1 floor,
    // which is the definition of "something executed" and nothing more: a
    // `toolchain` job where sixteen of seventeen files skipped and one cheap
    // case ran cleared it, and `required` went green over it.
    //
    // These numbers are DERIVED — the sum over the producer's PR-required
    // groups — so they move when the manifest moves and cannot be tuned here.
    const producers = capabilityProducers()
    expect(producers.length).toBeGreaterThan(0)
    const measured = Object.fromEntries(
      producers.map((row) => {
        const floor = capabilityFloorFor(row.id)
        return [row.id, { files: floor.minimumExecutedFiles, cases: floor.minimumExecutedCases }]
      }),
    )
    expect(measured).toEqual({
      pty: { files: 8, cases: 8 },
      toolchain: { files: 10, cases: 14 },
      contract: { files: 5, cases: 5 },
    })
    // ANTI-VACUITY: a floor of 0 makes the branch it guards unreachable, which
    // is how the original survivor hid, and every producer must name groups.
    for (const row of producers) {
      const floor = capabilityFloorFor(row.id)
      expect({ id: row.id, zero: floor.minimumExecutedFiles === 0 }).toEqual({
        id: row.id,
        zero: false,
      })
      expect({ id: row.id, groups: floor.groups.length }).not.toEqual({ id: row.id, groups: 0 })
    }
  })

  /**
   * The shape the flat floor could not see: a lane that clears an aggregate
   * total while an entire group never starts.
   */
  describe("per-group execution", () => {
    const toolchain = requiredProducers().find(
      (producer) => producer.id === "toolchain",
    ) as RequiredProducer

    /**
     * `cases` distributed so that every group with executed members clears its
     * OWN case floor, and the total reaches `cases`.
     *
     * An even spread is not enough, and finding that out is the point: 14 cases
     * over 10 files is 2 each, and `language-test-matrix` declares a floor of 3
     * over its single member. The first version of this helper spread evenly and
     * the new per-group check failed it — correctly. A fixture that cannot meet
     * the per-group floors is describing a lane that did not run its groups.
     */
    const artifactFor = (files: readonly string[], cases: number): unknown => {
      const floorFor = (file: string): number => {
        const group = capabilityFloorFor("toolchain").groups.find((candidate) =>
          candidate.members.includes(file),
        )
        if (group === undefined) return 1
        return Math.max(1, Math.ceil(group.minimumExecutedCases / group.members.length))
      }
      const byFile: Record<string, number> = Object.fromEntries(
        files.map((file) => [file, floorFor(file)]),
      )
      let total = files.reduce((sum, file) => sum + (byFile[file] ?? 0), 0)
      const first = files[0]
      if (first !== undefined && total < cases) {
        byFile[first] = (byFile[first] ?? 0) + (cases - total)
        total = cases
      }
      return {
        schema: CAPABILITY_RESULT_SCHEMA,
        producer: "toolchain",
        executedFiles: [...files],
        executedCases: total,
        executedCasesByFile: byFile,
        skippedUnsupported: 0,
        blockedMissing: 0,
        failedSetup: 0,
      }
    }

    const allMembers = capabilityFloorFor("toolchain").groups.flatMap((group) => [...group.members])

    test("every required group running is a PASS", () => {
      // ANTI-VACUITY: the negative arms below are only meaningful if the
      // complete set actually passes.
      expect(validateCapabilityResult(toolchain, artifactFor(allMembers, 14))).toEqual({ ok: true })
    })

    test("one group missing entirely is RED, and the group is NAMED", () => {
      const pyright = capabilityFloorFor("toolchain").groups.find(
        (group) => group.id === "lsp-pyright",
      ) as CapabilityGroupFloor
      const withoutPyright = allMembers.filter((file) => !pyright.members.includes(file))
      const verdict = validateCapabilityResult(toolchain, artifactFor(withoutPyright, 14))
      expect(verdict.ok).toBe(false)
      if (verdict.ok) throw new Error("unreachable")
      expect(verdict.reason).toContain('capability group "lsp-pyright"')
    })

    test("EVERY required group is individually load-bearing", () => {
      // Not one representative group: dropping any of them must fail, or the
      // check is a floor over whichever group happens to be smallest.
      for (const group of capabilityFloorFor("toolchain").groups) {
        const without = allMembers.filter((file) => !group.members.includes(file))
        const verdict = validateCapabilityResult(toolchain, artifactFor(without, 14))
        expect({ group: group.id, ok: verdict.ok }).toEqual({ group: group.id, ok: false })
      }
    })

    /**
     * The CASE floor per group, which v1 could not check at all.
     *
     * Every group declares `minExecutedCases` — `toolchain`'s seven are 4, 2, 1,
     * 1, 1, 2 and 3 — and the artifact published only a TOTAL, so the consumer
     * compared 14 against 14 and none of the seven numbers was ever read. A
     * group whose files ran while its cases did not was invisible behind a
     * sibling that over-ran.
     */
    /**
     * One case per member of `starved`, its own floor for every other group, and
     * the producer total padded OUTSIDE the starved group.
     *
     * Padding `allMembers[0]` pushed `lsp-rust` itself to 53 cases and the arm
     * passed for the wrong reason: the total has to be satisfied by a DIFFERENT
     * group, or this is not the case the total-only check was blind to.
     */
    const starvedArtifact = (starved: string): unknown => {
      const byFile: Record<string, number> = {}
      for (const group of capabilityFloorFor("toolchain").groups) {
        const perMember =
          group.id === starved
            ? 1
            : Math.max(1, Math.ceil(group.minimumExecutedCases / group.members.length))
        for (const member of group.members) byFile[member] = perMember
      }
      const members = capabilityFloorFor("toolchain").groups.find(
        (group) => group.id === starved,
      )?.members
      const padded = allMembers.find((file) => !(members ?? []).includes(file)) as string
      byFile[padded] = (byFile[padded] ?? 0) + 50
      return {
        schema: CAPABILITY_RESULT_SCHEMA,
        producer: "toolchain",
        executedFiles: allMembers,
        executedCases: Object.values(byFile).reduce((sum, count) => sum + count, 0),
        executedCasesByFile: byFile,
        skippedUnsupported: 0,
        blockedMissing: 0,
        failedSetup: 0,
      }
    }

    test("a group whose FILES ran but whose CASES did not is RED, and it is named", () => {
      const starvable = capabilityFloorFor("toolchain").groups.filter(
        (group) => group.minimumExecutedCases > group.members.length,
      )
      // ANTI-VACUITY: at least one group declares more cases than it has
      // members, or the loop below asserts nothing.
      expect(starvable.length).toBeGreaterThanOrEqual(1)
      for (const group of starvable) {
        const verdict = validateCapabilityResult(toolchain, starvedArtifact(group.id))
        expect({ group: group.id, ok: verdict.ok }).toEqual({ group: group.id, ok: false })
        if (verdict.ok) throw new Error("unreachable")
        expect(verdict.reason).toContain(`capability group "${group.id}"`)
        expect(verdict.reason).toContain(`floor is ${group.minimumExecutedCases}`)
      }
    })

    /**
     * The per-file map is what makes the check above possible, so it has to be
     * describable — and refusable.
     */
    test("a total that does not decompose into its files is REFUSED", () => {
      const base = artifactFor(allMembers, 14) as Record<string, unknown>
      for (const [why, override] of [
        ["a total larger than the sum", { executedCases: 9_999 }],
        [
          "a file with zero cases",
          {
            executedCasesByFile: {
              ...(base.executedCasesByFile as object),
              [allMembers[0] as string]: 0,
            },
          },
        ],
        [
          "a count for a file that did not execute",
          {
            executedCasesByFile: {
              ...(base.executedCasesByFile as object),
              "tests/never-ran.test.ts": 3,
            },
          },
        ],
        ["no map at all", { executedCasesByFile: undefined }],
      ] as const) {
        const verdict = validateCapabilityResult(toolchain, { ...base, ...override })
        expect({ why, ok: verdict.ok }).toEqual({ why, ok: false })
      }
      // PAIRED CONTROL: the intact artifact passes.
      expect(validateCapabilityResult(toolchain, base).ok).toBe(true)
    })

    test("1 executed + 999 skipped no longer clears the lane", () => {
      const one = validateCapabilityResult(toolchain, {
        schema: CAPABILITY_RESULT_SCHEMA,
        producer: "toolchain",
        executedFiles: [allMembers[0] as string],
        executedCases: 1,
        executedCasesByFile: { [allMembers[0] as string]: 1 },
        skippedUnsupported: 999,
        blockedMissing: 0,
        failedSetup: 0,
      })
      expect(one.ok).toBe(false)
      if (one.ok) throw new Error("unreachable")
      // Rejected, and the message names a floor rather than saying "required failed".
      expect(one.reason).toMatch(/floor is \d+/)
    })

    test("padding the COUNT with non-member files does not buy a pass", () => {
      // The aggregate floor is a count, so it is satisfiable by ten unrelated
      // paths. Group attribution is exact membership, which is why it is not.
      const padding = Array.from({ length: 20 }, (_, i) => `tests/unit/filler-${i}.test.ts`)
      const verdict = validateCapabilityResult(toolchain, artifactFor(padding, 99))
      expect(verdict.ok).toBe(false)
      if (verdict.ok) throw new Error("unreachable")
      expect(verdict.reason).toContain("capability group")
    })
  })
})
