/**
 * PMX-04 — the operator tool stays a THIN SHELL, and its real ports work.
 *
 * Two things a fake port can never establish, so they are tested here directly:
 *
 *  1. **Ownership.** `run-gate.ts` must contain no gate logic of its own. If a
 *     verdict, a hash, an argv flag, or a filename ever appears in the tool, the
 *     tool and the module can disagree — which is the exact failure the
 *     `assemble-bundle.ts` / `provenance` split exists to prevent.
 *  2. **The spawn port is REAL.** `exitCode: null` drives `evaluator_unavailable`,
 *     the most consequential disposition in the whole receipt. A hand-written
 *     fake returning `null` proves nothing about whether `spawnSync` actually
 *     reports `null` for a signalled process. So this file signals a real one.
 *
 * ⚠️ HERMETIC: no Docker, no network, no campaign directory. The processes
 * spawned are `/bin/sh` one-liners.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRunGateInput,
  makeRunGatePorts,
  readAssignedIdsFromGolden,
  renderGateResult,
} from "../../../../../tools/bench-promax/run-gate"

const TOOL_SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "..", "..", "tools", "bench-promax", "run-gate.ts"),
  "utf8",
)

/** Strip comments so the rail reads CODE, not prose about the code. */
const TOOL_CODE = TOOL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("run-gate tool — ownership (thin shell)", () => {
  test("the tool contains NO gate logic: every owned symbol stays in the module", () => {
    // Each of these is owned by `@/apps/bench/harness/promax`. The tool composes
    // ONE entry point and renders the result; it never re-derives any of them.
    for (const owned of [
      "sha256Hex",
      "buildGoldSentinelPatch",
      "serializeProMaxPredictions",
      "buildProMaxEvaluatorInvocation",
      "buildProMaxOfficialGradeReceipt",
      "evaluateGoldSentinelGate",
      "apply_failed",
      "model_miss",
      "--workers",
      "preds.json",
      "pass-rate.json",
      "gate-receipt.json",
    ]) {
      expect({ owned, presentInTool: TOOL_CODE.includes(owned) }).toEqual({
        owned,
        presentInTool: false,
      })
    }
  })

  test("the tool imports the ONE composed entry point", () => {
    expect(TOOL_CODE).toContain("runProMaxGate")
    expect(TOOL_CODE).toContain("@/apps/bench/harness/promax")
  })
})

describe("run-gate tool — argument handling refuses rather than guesses", () => {
  const base = [
    "--campaign",
    "c1",
    "--pinned-root",
    "/pinned",
    "--golden",
    "/golden.json",
    "--work-dir",
    "/work",
    "--python",
    "/venv/bin/python",
  ]

  test("REFUSES a missing required flag instead of defaulting a campaign path", () => {
    for (const drop of ["--campaign", "--pinned-root", "--golden", "--work-dir", "--python"]) {
      const i = base.indexOf(drop)
      const argv = [...base.slice(0, i), ...base.slice(i + 2)]
      expect(() => buildRunGateInput(argv)).toThrow(new RegExp(`\\${drop} is required`))
    }
  })

  test("reads assigned ids from the golden file when --ids is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmx-gate-tool-"))
    try {
      const golden = join(dir, "golden.json")
      writeFileSync(golden, JSON.stringify([{ instance_id: "a__b-1" }, { instance_id: "c__d-2" }]))
      expect(readAssignedIdsFromGolden(golden)).toEqual(["a__b-1", "c__d-2"])

      const i = base.indexOf("/golden.json")
      const argv = [...base]
      argv[i] = golden
      expect(buildRunGateInput(argv).assignedInstanceIds).toEqual(["a__b-1", "c__d-2"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("REFUSES a golden row with no usable instance_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmx-gate-tool-"))
    try {
      const golden = join(dir, "golden.json")
      writeFileSync(golden, JSON.stringify([{ instance_id: "a__b-1" }, { image_name: "x" }]))
      expect(() => readAssignedIdsFromGolden(golden)).toThrow(/row 1 has no usable instance_id/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an explicit --ids list overrides the golden file", () => {
    const argv = [...base, "--ids", "x__y-1, x__y-2 ,"]
    expect(buildRunGateInput(argv).assignedInstanceIds).toEqual(["x__y-1", "x__y-2"])
  })
})

describe("run-gate tool — exit codes", () => {
  const judged = (gateOk: boolean) =>
    ({
      outcome: "judged" as const,
      gate: { ok: gateOk, failures: [] },
      summary: {
        assigned: 7,
        resolved: 0,
        modelMiss: 7,
        infraInvalid: 0,
        ambiguous: 0,
        missing: 0,
        gradingValid: 7,
        officialValidRate: 0,
        coverage: 1,
        rawRate: 0,
      },
      receipt: {
        assignedInstanceIds: [],
        dispositionsByInstanceId: new Map(),
        evaluator: {
          evaluatorId: "e",
          upstreamCommit: "c",
          evaluatorPath: "/p",
          evaluatorSha256: "s",
          argv: ["python"],
          cwd: "/w",
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputArtifact: null,
        },
      },
      receiptPath: "/work/gate-receipt.json",
      predictionsPath: "/work/preds.json",
      outputPath: "/work/pass-rate.json",
      observation: { exitCode: 0, stdout: "", stderr: "" },
      verdictCounts: [{ state: "model_miss", reason: "patch_apply_failed", count: 7 }],
    }) as const

  test("a PASSING gate exits 0 and names the persisted receipt", () => {
    const rendered = renderGateResult(judged(true))
    expect(rendered.exitCode).toBe(0)
    expect(rendered.output).toContain("GATE gold-sentinel — PASS")
    expect(rendered.output).toContain("/work/gate-receipt.json")
  })

  test("a FAILING gate exits NON-ZERO — an operator script cannot miss it", () => {
    expect(renderGateResult(judged(false)).exitCode).toBe(1)
  })

  test("a REFUSAL exits non-zero and names the stage and code", () => {
    const rendered = renderGateResult({
      outcome: "refused",
      stage: "verify-evaluator",
      failures: [{ code: "evaluator_sha256_mismatch", message: "boom" }],
    })
    expect(rendered.exitCode).toBe(1)
    expect(rendered.output).toContain('REFUSED at stage "verify-evaluator"')
    expect(rendered.output).toContain("[evaluator_sha256_mismatch]")
  })
})

describe("run-gate tool — the REAL ports", () => {
  test("readBytes/readText/writeText round-trip, and absent files read as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmx-gate-ports-"))
    try {
      const ports = makeRunGatePorts()
      const nested = join(dir, "deep", "receipt.json")
      // writeText must create intermediate directories — the work dir may not exist
      ports.writeText(nested, '{"ok":true}')
      expect(ports.readText(nested)).toBe('{"ok":true}')
      expect(ports.readBytes(nested)).toEqual(new Uint8Array(Buffer.from('{"ok":true}')))
      expect(ports.readText(join(dir, "absent.json"))).toBeNull()
      expect(ports.readBytes(join(dir, "absent.json"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("spawn reports a REAL exit code, stdout and stderr", () => {
    const ports = makeRunGatePorts()
    const observed = ports.spawn(["/bin/sh", "-c", "echo out; echo err 1>&2; exit 3"], tmpdir())
    expect(observed.exitCode).toBe(3)
    expect(observed.stdout.trim()).toBe("out")
    expect(observed.stderr.trim()).toBe("err")
  })

  test("a SIGNALLED process really does report exitCode null (⇒ evaluator_unavailable)", () => {
    const ports = makeRunGatePorts()
    // This is the shape of the SIGTERM kill that a too-small budget produced on
    // the first real run — the case the receipt must call infrastructure.
    const observed = ports.spawn(["/bin/sh", "-c", "kill -TERM $$"], tmpdir())
    expect(observed.exitCode).toBeNull()
  })

  test("spawn runs in the cwd it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmx-gate-cwd-"))
    try {
      const ports = makeRunGatePorts()
      writeFileSync(join(dir, "marker.txt"), "x")
      const observed = ports.spawn(["/bin/sh", "-c", "ls"], dir)
      expect(observed.stdout).toContain("marker.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
