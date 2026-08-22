/**
 * aug-22 residual G5 — `toInstance(...).testCmd === "true"` for ProMax is
 * CORRECT, and this file exists so nobody "fixes" it into a leak.
 *
 * The reasoning, pinned as behaviour rather than prose:
 *
 *  1. ProMax rows carry NO `FAIL_TO_PASS` / `PASS_TO_PASS`. The pinned upstream
 *     evaluator (`src/evaluation/test_run.py`) owns grading, and PMX-02 forbids
 *     synthesizing a local test command from hidden eval metadata — a locally
 *     invented command would be a fake grade dressed as a real one. So the
 *     public projection emits the historical `"true"` no-op.
 *  2. `"true"` exits 0. That is only safe because `verify()`'s harness-required
 *     guard REFUSES to score a swebench instance through the local `testCmd`
 *     path at all. The absence therefore fails CLOSED (`harness_error`), never
 *     fake-green.
 *
 * Both halves are asserted here, with a PAIRED CONTROL proving the guard — not
 * some blanket refusal — is what produces the red, and with the "hidden eval
 * metadata" case made concrete: a row that DOES carry eval fields still yields
 * the no-op, so a future widening of the projection is a test failure.
 *
 * ⚠️ No box, no harness, no network: `verify()` is called with the Python
 * harness deliberately UNWIRED, and with an in-process fake for the wired case.
 */
import { describe, expect, test } from "bun:test"
import { readFamilyCorpusText } from "@/apps/bench/profiles/corpus-read"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import type { Instance } from "@/apps/bench/types"
import { verify } from "@/runner/batch/eval/verdict"
import { buildSyntheticProMaxCorpus, promaxDatasetRow } from "./promax-corpus-fixture"

const CORPUS = buildSyntheticProMaxCorpus()
const NON_EMPTY_PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+1\n"

const promaxInstances = (text: string): Instance[] =>
  readFamilyCorpusText(text, "promax").flatMap((row) =>
    row.task !== undefined ? [row.task.toInstance("/tmp/checkout")] : [],
  )

describe("G5 — the ProMax `testCmd` no-op is the ONLY honest value", () => {
  test("KNOWN-ITEM FLOOR — every row of a real-shaped corpus yields the no-op", () => {
    const instances = promaxInstances(CORPUS.datasetText)
    expect(instances).toHaveLength(170)
    for (const instance of instances) {
      expect(instance.testCmd, `${instance.id} synthesized a test command`).toBe("true")
      expect(instance.swebench?.instanceId).toBe(instance.id)
    }
  })

  test("a row that DOES carry hidden eval metadata still yields the no-op", () => {
    // The exact leak this pin guards: someone notices the row has eval fields and
    // "helpfully" derives a local command from them. Every spelling the upstream
    // ecosystem uses is present on this row.
    const row = promaxDatasetRow("promax__evalmeta-1", "python", 0, {
      FAIL_TO_PASS: '["tests/test_x.py::test_a"]',
      fail_to_pass: ["tests/test_x.py::test_a"],
      PASS_TO_PASS: '["tests/test_x.py::test_b"]',
      eval_script: "#!/bin/bash\npytest tests/test_x.py -q\n",
      test_cmd: "pytest tests/test_x.py -q",
      testCmd: "pytest tests/test_x.py -q",
    })
    const [instance] = promaxInstances(JSON.stringify([row]))
    expect(instance).toBeDefined()
    expect(instance?.testCmd).toBe("true")
    // …and none of that metadata reached the Instance by any other route.
    const serialized = JSON.stringify(instance)
    for (const marker of [
      "FAIL_TO_PASS",
      "fail_to_pass",
      "PASS_TO_PASS",
      "pytest",
      "eval_script",
    ]) {
      expect(serialized, `Instance leaked ${marker}`).not.toContain(marker)
    }
  })

  test("verify() with the harness UNWIRED refuses — even with a non-empty patch", async () => {
    const [instance] = promaxInstances(CORPUS.datasetText)
    if (instance === undefined) throw new Error("no runnable promax task")
    const outcome = await verify(instance, NON_EMPTY_PATCH, "/tmp/checkout", { timeoutMs: 1_000 })
    expect(outcome.passed).toBe(false)
    expect(outcome.error ?? "").toContain("REFUSING to fake-grade")
    expect(outcome.logTail).toContain("refused testCmd fake-grade")
  })

  test("PAIRED CONTROL — the SAME `true` command DOES pass for a non-swebench instance", async () => {
    // Proves the red above comes from the harness-required GUARD, not from a
    // blanket refusal and not because `true` somehow fails: strip the `swebench`
    // marker and the identical command scores green.
    const [promax] = promaxInstances(CORPUS.datasetText)
    if (promax === undefined) throw new Error("no runnable promax task")
    const { swebench: _swebench, ...plain } = promax
    expect(plain.testCmd).toBe("true")
    const outcome = await verify(plain as Instance, NON_EMPTY_PATCH, process.cwd(), {
      timeoutMs: 10_000,
    })
    expect(outcome.passed).toBe(true)
    expect(outcome.exitCode).toBe(0)
  })

  test("verify() with the harness WIRED to the ProMax family evaluator also refuses", async () => {
    // The other half: when a python harness IS wired, the family's own grade port
    // is what runs — and ProMax's refuses rather than routing to the Verified or
    // ScaleAI Pro harness. Either way there is no path to a green.
    const [instance] = promaxInstances(CORPUS.datasetText)
    if (instance === undefined) throw new Error("no runnable promax task")
    const evaluate = resolveDatasetFamilyProfile("promax").gradeEvaluator()
    let thrown: unknown
    try {
      await verify(instance, NON_EMPTY_PATCH, "/tmp/checkout", {
        timeoutMs: 1_000,
        pythonSwebench: { evaluate },
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(String((thrown as Error).message)).toContain("REFUSING to fall back")
    // PAIRED CONTROL — a wired harness that DOES return a verdict is honoured, so
    // the refusal above is ProMax's port talking, not a dead seam.
    const green = await verify(instance, NON_EMPTY_PATCH, "/tmp/checkout", {
      timeoutMs: 1_000,
      pythonSwebench: {
        evaluate: async () => ({ resolved: true, gradingCompleted: true, log: "" }),
      },
    })
    expect(green.passed).toBe(true)
  })
})
