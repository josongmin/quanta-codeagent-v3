/**
 * PMX-04 — the RUNNER actually submits what it was told to, and refuses to
 * pass judgment on a model stage.
 *
 * `submission.ts` is a pure function; this file is the proof that the live
 * runner calls it. The strongest observation here is not the outcome tag — it
 * is the BYTES of the predictions file the evaluator was pointed at. A runner
 * that still broadcast the sentinel patch would return `outcome: "graded"`
 * exactly as this one does; only the file contents tell the two apart.
 *
 * The second property is the one that makes Gate 2 honest: a model stage is
 * GRADED here and JUDGED by PMX-06. Reusing the gold-sentinel gate would report
 * PASS for "none of the patches applied" — the precise inverse of what a model
 * stage means — so the runner must decline to produce a verdict at all.
 */
import { describe, expect, test } from "bun:test"
import {
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
  type ProMaxGateReceiptDocument,
  type ProMaxGateRunPorts,
  runProMaxGate,
} from "@/apps/bench/harness/promax"
import { sha256Hex } from "@/apps/bench/promax/provenance"

const CAMPAIGN = "pmx7-model-test"
const ROOT = "/campaign/pinned"
const WORK = "/campaign/work"
const GOLDEN = "/campaign/golden.json"
const IDS = ["aws__s2n-tls-5464", "samber__lo-739"] as const

const EVALUATOR_BYTES = "# pinned evaluator fixture\n"
const EVAL_META_BYTES = '{"fixture": true}\n'
const FIXTURE_PINS = {
  evaluatorSha256: sha256Hex(new TextEncoder().encode(EVALUATOR_BYTES)),
  evalMetaSha256: sha256Hex(new TextEncoder().encode(EVAL_META_BYTES)),
}

/** A pass-rate row shaped like the pinned evaluator writes one. */
const row = (instanceId: string, model: string): Record<string, unknown> => ({
  instance_id: instanceId,
  language: "c",
  passed: model === "success",
  model: { final_result: model, raw_reason: model, returncode: 0, script_exit_code: 0 },
  golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
})

const makeHarness = () => {
  const writes = new Map<string, string>()
  const files = new Map<string, string>([
    [`${ROOT}/${PROMAX_EVALUATOR_RELATIVE_PATH}`, EVALUATOR_BYTES],
    [`${ROOT}/${PROMAX_EVAL_META_RELATIVE_PATH}`, EVAL_META_BYTES],
  ])
  const ports: ProMaxGateRunPorts = {
    readBytes: (p) => {
      const text = files.get(p)
      return text === undefined ? null : new TextEncoder().encode(text)
    },
    readText: (p) => writes.get(p) ?? files.get(p) ?? null,
    writeText: (p, text) => {
      writes.set(p, text)
    },
    probePython: () => ({ exitCode: 0, stdout: "Python 3.11.14\n", stderr: "" }),
    spawn: () => {
      // One real resolve, one real miss — a model stage is not all-or-nothing.
      // Both verdicts are values the PINNED schema defines (`OFFICIAL_FINAL_RESULTS`);
      // an invented string would grade as a schema drift, not as a model miss.
      writes.set(
        `${WORK}/pass-rate.json`,
        JSON.stringify([row(IDS[0], "success"), row(IDS[1], "non zero exit")]),
      )
      return { exitCode: 0, stdout: "", stderr: "" }
    },
    now: () => "2026-08-23T00:00:00.000Z",
  }
  return { ports, writes }
}

const base = {
  campaignId: CAMPAIGN,
  assignedInstanceIds: IDS,
  pinnedRoot: ROOT,
  goldenPath: GOLDEN,
  workDir: WORK,
  pythonExecutable: "/venv/bin/python",
}

const MODEL_PATCHES = [
  { instanceId: IDS[0], modelPatch: "--- a/s2n.c\n+++ b/s2n.c\n@@ -1 +1 @@\n-a\n+b\n" },
  { instanceId: IDS[1], modelPatch: "--- a/lo.go\n+++ b/lo.go\n@@ -1 +1 @@\n-c\n+d\n" },
] as const

describe("a model stage submits the AGENT's patches", () => {
  test("the predictions file the evaluator reads contains the model patches, not a sentinel", () => {
    const h = makeHarness()
    const result = runProMaxGate(
      { ...base, submission: { kind: "model", patches: MODEL_PATCHES } },
      h.ports,
      FIXTURE_PINS,
    )
    expect(result.outcome).toBe("graded")
    if (result.outcome !== "graded") throw new Error("unreachable")

    // THE live-call proof: read back the bytes actually written.
    const preds = JSON.parse(h.writes.get(result.predictionsPath) ?? "[]") as {
      instance_id: string
      model_patch: string
    }[]
    expect(preds).toHaveLength(2)
    for (const want of MODEL_PATCHES) {
      const got = preds.find((p) => p.instance_id === want.instanceId)
      expect(got?.model_patch).toBe(want.modelPatch)
    }
    // distinct patches — a broadcast (the sentinel shape) would collapse to one
    expect(new Set(preds.map((p) => p.model_patch)).size).toBe(2)
  })

  test("the stage is GRADED, never judged by the gold-sentinel gate", () => {
    const h = makeHarness()
    const result = runProMaxGate(
      { ...base, submission: { kind: "model", patches: MODEL_PATCHES } },
      h.ports,
      FIXTURE_PINS,
    )
    if (result.outcome !== "graded") throw new Error("unreachable")
    // A resolved instance would be a gold-sentinel FAILURE (`sentinel_not_apply_failed`).
    // Here it must simply be a resolved row — proof the sentinel gate never ran.
    expect(result.summary.assigned).toBe(2)
    expect(result.summary.resolved).toBe(1)
    expect(result.summary.gradingValid).toBe(2)
    expect(result.summary.missing).toBe(0)
    expect("gate" in result).toBe(false)
  })

  test("the persisted document names the model stage and withholds a verdict", () => {
    const h = makeHarness()
    const result = runProMaxGate(
      { ...base, submission: { kind: "model", patches: MODEL_PATCHES } },
      h.ports,
      FIXTURE_PINS,
    )
    if (result.outcome !== "graded") throw new Error("unreachable")
    const doc = JSON.parse(h.writes.get(result.receiptPath) ?? "{}") as ProMaxGateReceiptDocument
    expect(doc.gate).toBe("model-smoke")
    // null, NOT false — "not judged here" must not read as "failed".
    expect(doc.gateOk).toBeNull()
    expect(doc.gateFailures).toEqual([])
    // the receipt itself is still complete evidence for PMX-06 to judge
    expect(doc.receipt).toBeDefined()
  })

  test("PAIRED CONTROL: the gold-sentinel submission still JUDGES, from the same runner", () => {
    const h = makeHarness()
    const result = runProMaxGate(
      { ...base, submission: { kind: "gold-sentinel" } },
      h.ports,
      FIXTURE_PINS,
    )
    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    // one sentinel patch, broadcast — the shape the model path must NOT have
    const preds = JSON.parse(h.writes.get(result.predictionsPath) ?? "[]") as {
      model_patch: string
    }[]
    expect(new Set(preds.map((p) => p.model_patch)).size).toBe(1)
    // and it DOES issue a verdict (this fixture resolves one instance, so the
    // sentinel gate correctly fails — the point is that a verdict exists)
    expect(typeof result.gate.ok).toBe("boolean")
  })

  test("a model submission missing an assigned instance refuses BEFORE spawning", () => {
    const h = makeHarness()
    const result = runProMaxGate(
      { ...base, submission: { kind: "model", patches: [MODEL_PATCHES[0]] } },
      h.ports,
      FIXTURE_PINS,
    )
    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("predictions")
    expect(result.failures.map((f) => f.code)).toContain("patch_absent_for_assigned")
    // nothing was written: no predictions file, no receipt
    expect(h.writes.size).toBe(0)
  })
})
