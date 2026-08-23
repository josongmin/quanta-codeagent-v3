/**
 * PMX-04 — the ProMax gate RUN boundary: the composed process-spawn step that
 * PMX-03 deferred.
 *
 * These tests drive an INJECTED spawn/fs port. Nothing here starts a process,
 * touches Docker, or reads the operator's real campaign directories.
 *
 * The behaviours pinned here are the ones the first real Gate-1 run taught:
 *  - the pinned evaluator is hash-verified BEFORE anything is spawned;
 *  - the receipt is built from all four observed process facts;
 *  - a gate leaves EVIDENCE on disk even when it FAILS;
 *  - each refusal keeps its own distinct, named reason.
 */
import { describe, expect, test } from "bun:test"
import {
  buildGoldSentinelPatch,
  buildProMaxOfficialGradeReceipt,
  goldSentinelPath,
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
  type ProMaxEvaluatorRun,
} from "@/apps/bench/harness/promax"
import {
  buildProMaxEvaluatorIdentity,
  PROMAX_GATE_RECEIPT_FILENAME,
  PROMAX_V1_EVALUATOR_PINS,
  type ProMaxGateRunPorts,
  runProMaxGate,
} from "@/apps/bench/harness/promax/gate-run"
import { sha256Hex } from "@/apps/bench/promax/provenance"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { parseOfficialGradeReceipt } from "@/runner/batch/eval/official-grade"

const CAMPAIGN = "pmx7-gold-test"
const ROOT = "/campaign/pinned"
const WORK = "/campaign/work"
const GOLDEN = "/campaign/golden.json"

const IDS = ["aws__s2n-tls-5464", "deskflow__deskflow-c_c2ee366", "samber__lo-739"] as const

/** Fixture bytes standing in for the pinned upstream files. */
const EVALUATOR_BYTES = "# pinned evaluator fixture\n"
const EVAL_META_BYTES = '{"fixture": true}\n'

/** Pins that MATCH the fixture bytes, for the happy path. */
const FIXTURE_PINS = {
  evaluatorSha256: sha256Hex(EVALUATOR_BYTES),
  evalMetaSha256: sha256Hex(EVAL_META_BYTES),
}

interface Harness {
  readonly ports: ProMaxGateRunPorts
  readonly writes: Map<string, string>
  readonly spawns: { argv: readonly string[]; cwd: string }[]
}

/**
 * What the fixture interpreter reports.
 *
 * A real box answers `--version`, so the fake does too. It is above the pinned
 * evaluator's 3.10 floor because these tests are about the gate's composition,
 * not about the floor — `promax-evaluator-python-floor.test.ts` owns that, and
 * drives the refusal from here with a 3.9 answer.
 */
const FIXTURE_PYTHON_VERSION = "Python 3.11.14\n"

/** A pass-rate row shaped exactly like the pinned evaluator writes one. */
const passRateRow = (
  instanceId: string,
  model: string,
  golden: string,
): Record<string, unknown> => ({
  instance_id: instanceId,
  language: "c",
  passed: false,
  model: { final_result: model, raw_reason: model, returncode: 8, script_exit_code: 8 },
  golden: { final_result: golden, raw_reason: golden, returncode: 0, script_exit_code: 0 },
})

const sentinelPassRate = (ids: readonly string[]): string =>
  JSON.stringify(ids.map((id) => passRateRow(id, "apply_failed", "success")))

interface HarnessOptions {
  /** what the spawned process "writes" to the --output path; null = never written. */
  readonly output?: string | null
  readonly exitCode?: number | null
  readonly evaluatorBytes?: string
}

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const writes = new Map<string, string>()
  const spawns: { argv: readonly string[]; cwd: string }[] = []
  const files = new Map<string, string>([
    [`${ROOT}/${PROMAX_EVALUATOR_RELATIVE_PATH}`, options.evaluatorBytes ?? EVALUATOR_BYTES],
    [`${ROOT}/${PROMAX_EVAL_META_RELATIVE_PATH}`, EVAL_META_BYTES],
  ])
  const outputPath = `${WORK}/pass-rate.json`
  const ports: ProMaxGateRunPorts = {
    readBytes: (p) => {
      const text = files.get(p)
      return text === undefined ? null : new TextEncoder().encode(text)
    },
    readText: (p) => writes.get(p) ?? files.get(p) ?? null,
    writeText: (p, text) => {
      writes.set(p, text)
    },
    probePython: () => ({ exitCode: 0, stdout: FIXTURE_PYTHON_VERSION, stderr: "" }),
    spawn: (argv, cwd) => {
      spawns.push({ argv, cwd })
      const output = options.output === undefined ? sentinelPassRate(IDS) : options.output
      if (output !== null) writes.set(outputPath, output)
      return {
        exitCode: options.exitCode === undefined ? 0 : options.exitCode,
        stdout: "",
        stderr: "",
      }
    },
    now: () => "2026-08-23T00:00:00.000Z",
  }
  return { ports, writes, spawns }
}

const baseInput = {
  campaignId: CAMPAIGN,
  // Gate 1 shape. `submission` is REQUIRED so a model run cannot silently
  // grade a sentinel; these tests are the sentinel path.
  submission: { kind: "gold-sentinel" } as const,
  assignedInstanceIds: IDS,
  pinnedRoot: ROOT,
  goldenPath: GOLDEN,
  workDir: WORK,
  pythonExecutable: "/venv/bin/python",
}

describe("promax gate run — pinned evaluator verification", () => {
  test("the DEFAULT pins are the frozen v1 snapshot, not a local constant", () => {
    expect(PROMAX_V1_EVALUATOR_PINS.evaluatorSha256).toBe(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    expect(PROMAX_V1_EVALUATOR_PINS.evalMetaSha256).toBe(PROMAX_V1_SNAPSHOT.eval_sha256)
  })

  test("REFUSES a tampered evaluator, and refuses it BEFORE spawning anything", () => {
    const h = makeHarness()
    // no pins argument => the production default (the real frozen snapshot),
    // which the fixture bytes deliberately do not match.
    const result = runProMaxGate(baseInput, h.ports)

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("verify-evaluator")
    expect(result.failures.map((f) => f.code)).toContain("evaluator_sha256_mismatch")
    // THE point of verifying first: an unverified evaluator never runs.
    expect(h.spawns).toHaveLength(0)
  })

  test("REFUSES an absent evaluator file with its own distinct code", () => {
    const h = makeHarness()
    const ports: ProMaxGateRunPorts = { ...h.ports, readBytes: () => null }
    const result = runProMaxGate(baseInput, ports, FIXTURE_PINS)

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.failures.map((f) => f.code)).toContain("evaluator_file_absent")
    expect(h.spawns).toHaveLength(0)
  })

  test("REFUSES a work dir that already holds an evaluator output file", () => {
    // The dangerous shape: a re-run in a used work dir where the evaluator dies
    // early. Reading the leftover file would grade THIS run against the LAST
    // one's verdicts — a green gate built from evidence that is not its own.
    const h = makeHarness()
    h.ports.writeText(`${WORK}/pass-rate.json`, sentinelPassRate(IDS))
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("work-dir")
    expect(result.failures.map((f) => f.code)).toContain("stale_output_present")
    expect(h.spawns).toHaveLength(0)
  })
})

describe("promax gate run — composition of the production builders", () => {
  test("writes sentinel predictions carrying the production patch and NO gold", () => {
    const h = makeHarness()
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)
    expect(result.outcome).toBe("judged")

    const preds = JSON.parse(h.writes.get(`${WORK}/preds.json`) ?? "null") as Array<
      Record<string, unknown>
    >
    expect(preds).toHaveLength(IDS.length)
    const expectedPatch = buildGoldSentinelPatch(CAMPAIGN)
    for (const row of preds) {
      expect(Object.keys(row).sort()).toEqual(["instance_id", "model_patch"])
      expect(row.model_patch).toBe(expectedPatch)
    }
    // the sentinel is campaign-derived and cannot exist in a repo
    expect(expectedPatch).toContain(goldSentinelPath(CAMPAIGN))
  })

  test("spawns EXACTLY the built argv, at the pinned root, with --workers 1", () => {
    const h = makeHarness()
    runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(h.spawns).toHaveLength(1)
    const spawned = h.spawns[0]
    if (spawned === undefined) throw new Error("no spawn observed")
    expect(spawned.cwd).toBe(ROOT)
    expect(spawned.argv[0]).toBe("/venv/bin/python")
    expect(spawned.argv[1]).toBe(`${ROOT}/${PROMAX_EVALUATOR_RELATIVE_PATH}`)
    expect(spawned.argv).toContain("--workers")
    expect(spawned.argv[spawned.argv.indexOf("--workers") + 1]).toBe("1")
    expect(spawned.argv).toContain(GOLDEN)
    // --cleanup would delete the campaign's replay evidence
    expect(spawned.argv).not.toContain("--cleanup")
  })
})

describe("promax gate run — the judged receipt", () => {
  test("reproduces the gold-sentinel verdict and PERSISTS the receipt", () => {
    const h = makeHarness()
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    expect(result.gate.ok).toBe(true)
    expect(result.summary.assigned).toBe(IDS.length)
    expect(result.summary.gradingValid).toBe(IDS.length)
    expect(result.summary.coverage).toBe(1)
    expect(result.summary.missing).toBe(0)
    expect(result.summary.infraInvalid).toBe(0)

    for (const id of IDS) {
      const d = result.receipt.dispositionsByInstanceId.get(id)
      expect(d?.state).toBe("model_miss")
      expect(d?.reason).toBe("patch_apply_failed")
      expect(d?.evaluator.golden?.finalResult).toBe("success")
      expect(d?.evaluator.model?.finalResult).toBe("apply_failed")
    }

    // EVIDENCE ON DISK — the thing Gate 1 did not leave.
    expect(result.receiptPath).toBe(`${WORK}/${PROMAX_GATE_RECEIPT_FILENAME}`)
    const persisted = h.writes.get(result.receiptPath)
    expect(persisted).toBeDefined()
    const doc = JSON.parse(persisted ?? "null") as Record<string, unknown>
    expect(doc.gate).toBe("gold-sentinel")
    expect(doc.gateOk).toBe(true)
    expect(doc.campaignId).toBe(CAMPAIGN)
    // the embedded receipt must survive the SAME fail-closed parse as construction
    const reparsed = parseOfficialGradeReceipt(doc.receipt)
    expect(reparsed.ok).toBe(true)
  })

  test("a MISSING output file is evaluator_no_output — and still leaves evidence", () => {
    const h = makeHarness({ output: null })
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    expect(result.gate.ok).toBe(false)
    for (const id of IDS) {
      const d = result.receipt.dispositionsByInstanceId.get(id)
      expect(d?.state).toBe("infra_invalid")
      expect(d?.reason).toBe("evaluator_no_output")
    }
    // never silently a model failure, never "missing"
    expect(result.summary.modelMiss).toBe(0)
    expect(result.summary.missing).toBe(0)
    expect(result.summary.infraInvalid).toBe(IDS.length)
    // a FAILED gate must leave its evidence too
    expect(h.writes.get(result.receiptPath)).toBeDefined()
  })

  test("a crashed evaluator (no exit status) is evaluator_unavailable", () => {
    const h = makeHarness({ exitCode: null, output: null })
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    expect(result.gate.ok).toBe(false)
    for (const id of IDS) {
      expect(result.receipt.dispositionsByInstanceId.get(id)?.reason).toBe("evaluator_unavailable")
    }
  })

  test("verdictCounts tally MIXED (state, reason) pairs separately", () => {
    // Every other fixture here is uniform, which cannot distinguish a correct
    // tally from one that collapses distinct pairs into a single bucket.
    const [a, b, c] = IDS
    if (a === undefined || b === undefined || c === undefined) throw new Error("bad fixture")
    const h = makeHarness({
      output: JSON.stringify([
        passRateRow(a, "apply_failed", "success"), // model_miss / patch_apply_failed
        passRateRow(b, "test_patch_apply_failed", "success"), // model_miss / test_patch_apply_failed
        passRateRow(c, "apply_failed", "timeout_eval"), // infra_invalid / golden_timeout_eval
      ]),
    })
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)
    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")

    expect(result.verdictCounts).toHaveLength(3)
    expect(
      [...result.verdictCounts].map((v) => `${v.state}/${v.reason}=${v.count}`).sort(),
    ).toEqual([
      "infra_invalid/golden_timeout_eval=1",
      "model_miss/patch_apply_failed=1",
      "model_miss/test_patch_apply_failed=1",
    ])
    // the tally covers the whole denominator, exactly once each
    expect(result.verdictCounts.reduce((n, v) => n + v.count, 0)).toBe(IDS.length)
  })

  test("a sentinel that APPLIED fails the gate — the preflight is never vacuous", () => {
    const h = makeHarness({
      output: JSON.stringify(IDS.map((id) => passRateRow(id, "success", "success"))),
    })
    const result = runProMaxGate(baseInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    expect(result.gate.ok).toBe(false)
    expect(result.gate.failures.map((f) => f.code)).toEqual(IDS.map(() => "model_not_apply_failed"))
  })
})

describe("promax gate run — evaluator identity is real, never placeholder", () => {
  test("the built identity carries all six replay fields, from the frozen pin", () => {
    const built = buildProMaxEvaluatorIdentity({
      evaluatorPath: `${ROOT}/${PROMAX_EVALUATOR_RELATIVE_PATH}`,
      evaluatorSha256: PROMAX_V1_SNAPSHOT.evaluator_sha256,
      argv: ["python", "test_run.py"],
      cwd: ROOT,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error("unreachable")
    expect(built.identity.upstreamCommit).toBe(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(built.identity.evaluatorSha256).toBe(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    for (const value of [
      built.identity.evaluatorId,
      built.identity.upstreamCommit,
      built.identity.evaluatorPath,
      built.identity.evaluatorSha256,
      built.identity.cwd,
    ]) {
      expect(value.trim()).not.toBe("")
    }
    expect(built.identity.argv.length).toBeGreaterThan(0)
  })

  test("REFUSES to mint an identity with a blank field", () => {
    const built = buildProMaxEvaluatorIdentity({
      evaluatorPath: "",
      evaluatorSha256: PROMAX_V1_SNAPSHOT.evaluator_sha256,
      argv: ["python"],
      cwd: ROOT,
    })
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error("unreachable")
    expect(built.failures.map((f) => f.code)).toContain("identity_incomplete")
  })

  test("the RECEIPT builder still refuses incomplete metadata — guard preserved", () => {
    const run: ProMaxEvaluatorRun = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputJsonText: sentinelPassRate(IDS),
      outputPath: "/campaign/work/pass-rate.json",
    }
    const built = buildProMaxOfficialGradeReceipt({
      assignedInstanceIds: IDS,
      // upstreamCommit blank — the exact sloppiness that must not produce a receipt
      evaluator: {
        evaluatorId: "swe-bench-promax",
        upstreamCommit: "",
        evaluatorPath: "/campaign/pinned/src/evaluation/test_run.py",
        evaluatorSha256: PROMAX_V1_SNAPSHOT.evaluator_sha256,
        argv: ["python"],
        cwd: "/campaign/pinned",
      },
      run,
    })
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error("unreachable")
    expect(built.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
  })
})
