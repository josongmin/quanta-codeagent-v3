/**
 * PMX-04 — WHERE A ProMax CHUNK'S VERDICTS COME FROM.
 *
 * Every other family grades inline during patch-gen, so the chunk reads its
 * verdicts out of the bench `report.json`. ProMax cannot: its agent phase runs
 * with the answer key ABSENT (an `absenceProbe` proves it) and its grading needs
 * the key present, so the two are separate on-box invocations. The report from
 * the patch-gen pass therefore records every instance as an explicit
 * "swebench instance requires the official Python harness — REFUSING to
 * fake-grade" infra error, BY CONSTRUCTION.
 *
 * Reading verdicts from that report would report a total infra failure for a
 * chunk that graded perfectly well. So the verdicts come from the pinned
 * evaluator's own `pass-rate.json` instead, projected here.
 *
 * The projection is LOSSY in one direction and the loss is deliberate: the
 * chunk's transport has four buckets and the official grade has four STATES that
 * do not line up. `ambiguous` — which upstream reaches for `need_human_review` —
 * has no bucket of its own, and is mapped to `errored` rather than to
 * `unresolved`. That direction matters: `unresolved` reads as "the model tried
 * and failed", which is a claim about the MODEL. An ambiguous row is a claim
 * about the GRADE, and must never be counted as a measured model miss.
 *
 * The authoritative ProMax verdicts remain the official grade receipt; this is
 * pool/dashboard bookkeeping.
 */
import { describe, expect, test } from "bun:test"
import { projectProMaxGradedInstances } from "@/apps/bench/harness/promax/chunk-verdicts"
import { bucketsFromGradedInstances } from "@/apps/bench/remote/verdict-buckets"

/** The chunk's four arrays, as the REMOTE layer builds them from the states this
 *  module reports. Composed here so the tests below still pin the end-to-end
 *  answer, while each side keeps its own job: the family says what it MEASURED,
 *  the transport decides how that lands in four lossier buckets. */
const projectProMaxChunkVerdicts = (text: string) =>
  bucketsFromGradedInstances(projectProMaxGradedInstances(text))

/** A pass-rate row shaped exactly as the pinned evaluator writes one. */
const row = (instanceId: string, model: string, golden = "success"): Record<string, unknown> => ({
  instance_id: instanceId,
  language: "c",
  passed: model === "success" && golden === "success",
  model: { final_result: model, raw_reason: model, returncode: 0, script_exit_code: 0 },
  golden: { final_result: golden, raw_reason: golden, returncode: 0, script_exit_code: 0 },
})

const doc = (rows: readonly Record<string, unknown>[]): string => JSON.stringify(rows)

describe("pass-rate.json is projected into the chunk's four verdict sets", () => {
  test("KNOWN-ITEM FLOOR: a resolved row lands in `resolved`", () => {
    const v = projectProMaxChunkVerdicts(doc([row("repo__a-1", "success")]))
    expect(v.resolved).toEqual(["repo__a-1"])
    expect(v.unresolved).toEqual([])
    expect(v.errored).toEqual([])
  })

  test("a real model failure lands in `unresolved`, not `errored`", () => {
    const v = projectProMaxChunkVerdicts(doc([row("repo__b-2", "non zero exit")]))
    expect(v.unresolved).toEqual(["repo__b-2"])
    expect(v.resolved).toEqual([])
    expect(v.errored).toEqual([])
  })

  test("🔴 an AMBIGUOUS row is `errored`, never `unresolved`", () => {
    // `need_human_review` on the golden side: the GRADE is undecided. Counting it
    // as `unresolved` would assert the model was measured and missed.
    const v = projectProMaxChunkVerdicts(doc([row("repo__c-3", "success", "need_human_review")]))
    expect(v.errored).toEqual(["repo__c-3"])
    expect(v.unresolved).toEqual([])
    expect(v.resolved).toEqual([])
  })

  test("an infra-invalid row is `errored`", () => {
    // golden itself failed to apply ⇒ nothing about the model was measured
    const v = projectProMaxChunkVerdicts(doc([row("repo__d-4", "success", "apply_failed")]))
    expect(v.errored).toEqual(["repo__d-4"])
    expect(v.resolved).toEqual([])
  })

  test("EVERY row is accounted for exactly once — a covering partition", () => {
    const ids = ["a", "b", "c", "d"]
    const v = projectProMaxChunkVerdicts(
      doc([
        row("a", "success"),
        row("b", "non zero exit"),
        row("c", "success", "need_human_review"),
        row("d", "success", "apply_failed"),
      ]),
    )
    const all = [...v.resolved, ...v.unresolved, ...v.errored, ...v.emptyPatch]
    expect(all.sort()).toEqual(ids.sort())
    expect(new Set(all).size).toBe(all.length) // no id in two buckets
  })
})

describe("a grade artifact that cannot be trusted yields NOTHING, never a pass", () => {
  test("unparseable JSON ⇒ empty sets, so the chunk reads as no-verdict", () => {
    const v = projectProMaxChunkVerdicts("{not json")
    expect(v.resolved).toEqual([])
    expect(v.unresolved).toEqual([])
    expect(v.errored).toEqual([])
    expect(v.emptyPatch).toEqual([])
  })

  test("an empty artifact ⇒ empty sets", () => {
    for (const text of ["", "   ", "[]"]) {
      const v = projectProMaxChunkVerdicts(text)
      expect(v.resolved, `"${text}" produced resolutions`).toEqual([])
    }
  })

  test("🔴 a row with an UNRECOGNIZED verdict is never silently resolved", () => {
    // A drifted evaluator schema must not be able to manufacture a pass.
    const v = projectProMaxChunkVerdicts(doc([row("repo__e-5", "totally_new_state")]))
    expect(v.resolved).toEqual([])
    expect([...v.unresolved, ...v.errored]).toContain("repo__e-5")
  })

  test("PAIRED CONTROL: the same document with a KNOWN verdict does resolve", () => {
    const v = projectProMaxChunkVerdicts(doc([row("repo__e-5", "success")]))
    expect(v.resolved).toEqual(["repo__e-5"])
  })
})
