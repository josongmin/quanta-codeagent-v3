/**
 * PMX-04 — WHAT GETS SUBMITTED TO THE PINNED EVALUATOR.
 *
 * `runProMaxGate` built its predictions inline and unconditionally:
 *
 *     const patch = buildGoldSentinelPatch(input.campaignId)
 *     serializeProMaxPredictions(
 *       input.assignedInstanceIds.map((id) => ({ instanceId: id, modelPatch: patch })),
 *     )
 *
 * Every instance got the SAME synthetic non-applying patch. That is exactly
 * right for Gate 1 (the gold sentinel) and it is the only thing the runner could
 * ever do — there was no way to submit real model patches, so Gate 2 (PMX-7
 * model) had no runner at all.
 *
 * This is the submission layer that makes the runner's payload a typed choice.
 * It owns exactly ONE thing the predictions serializer cannot know: the
 * relationship between the submitted patches and the campaign's ASSIGNED SET.
 * (Blank ids, duplicate ids and the field projection that keeps a gold-bearing
 * `patch` field out of the file are already the serializer's job, and are not
 * re-implemented here.)
 *
 * The two refusals below are both about Gate 2's covering partition
 * (`assigned = resolved + model_miss + infra_invalid + ambiguous + missing`) and
 * its "zero missing" clause:
 *
 *  - an assigned instance with NO row grades as `missing`, which fails the gate
 *    LATER and further away, so it is refused HERE, before the evaluator spawns;
 *  - a row for an UNASSIGNED instance would have the evaluator grade work the
 *    campaign never assigned, silently widening the denominator.
 *
 * And the case that must NOT refuse: an EMPTY patch. An agent that produced
 * nothing is a real, measurable outcome — it has to reach the evaluator and come
 * back as a model miss. Dropping it would move a genuine failure into `missing`,
 * i.e. turn a measurement into a measurement HOLE.
 */
import { describe, expect, test } from "bun:test"
import { buildGoldSentinelPatch } from "@/apps/bench/harness/promax"
import { buildProMaxSubmission } from "@/apps/bench/harness/promax/submission"

const ASSIGNED = ["repo__a-1", "repo__b-2", "repo__c-3"] as const
const CAMPAIGN = "pmx7-model-2026-08-23"

const modelSubmission = (patches: readonly { instanceId: string; modelPatch: string }[]) =>
  buildProMaxSubmission(
    { kind: "model", patches },
    { assignedInstanceIds: ASSIGNED, campaignId: CAMPAIGN },
  )

const fullCoverage = ASSIGNED.map((id, i) => ({
  instanceId: id,
  modelPatch: `--- a/f${i}.py\n+++ b/f${i}.py\n@@ -1 +1 @@\n-x\n+y\n`,
}))

describe("gold-sentinel submission (Gate 1) is unchanged", () => {
  test("every assigned instance gets the SAME campaign-unique sentinel patch", () => {
    const r = buildProMaxSubmission(
      { kind: "gold-sentinel" },
      { assignedInstanceIds: ASSIGNED, campaignId: CAMPAIGN },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.predictions).toHaveLength(ASSIGNED.length)
    const expected = buildGoldSentinelPatch(CAMPAIGN)
    for (const p of r.predictions) expect(p.modelPatch).toBe(expected)
    expect(r.predictions.map((p) => p.instanceId)).toEqual([...ASSIGNED])
  })
})

describe("model submission (Gate 2) — reconciled against the assigned set", () => {
  test("KNOWN-ITEM FLOOR: full coverage is accepted and preserved per instance", () => {
    const r = modelSubmission(fullCoverage)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.predictions).toHaveLength(3)
    // each instance keeps ITS OWN patch — not a broadcast, which is the exact
    // shape the gold-sentinel path has and the model path must not have
    expect(new Set(r.predictions.map((p) => p.modelPatch)).size).toBe(3)
    for (const want of fullCoverage) {
      const got = r.predictions.find((p) => p.instanceId === want.instanceId)
      expect(got?.modelPatch).toBe(want.modelPatch)
    }
  })

  test("an assigned instance with NO patch REFUSES (it would grade as `missing`)", () => {
    const r = modelSubmission(fullCoverage.slice(0, 2))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failures.map((f) => f.code)).toContain("patch_absent_for_assigned")
    // names the instance, so the operator does not have to diff two lists
    expect(r.failures.map((f) => f.message).join(" ")).toContain("repo__c-3")
  })

  test("a patch for an UNASSIGNED instance REFUSES (it would widen the denominator)", () => {
    const r = modelSubmission([...fullCoverage, { instanceId: "repo__z-9", modelPatch: "x" }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failures.map((f) => f.code)).toContain("patch_not_assigned")
    expect(r.failures.map((f) => f.message).join(" ")).toContain("repo__z-9")
  })

  test("an EMPTY patch is ACCEPTED — 'the agent produced nothing' is a measurement, not a hole", () => {
    const withEmpty = [{ instanceId: ASSIGNED[0], modelPatch: "" }, ...fullCoverage.slice(1)]
    const r = modelSubmission(withEmpty)
    expect(r.ok, "an empty patch was refused — that turns a model miss into `missing`").toBe(true)
    if (!r.ok) return
    expect(r.predictions.find((p) => p.instanceId === ASSIGNED[0])?.modelPatch).toBe("")
    expect(r.predictions).toHaveLength(3)
  })

  test("PAIRED CONTROL: the two refusals are independent, and both can fire at once", () => {
    const r = modelSubmission([
      fullCoverage[0] as { instanceId: string; modelPatch: string },
      { instanceId: "repo__z-9", modelPatch: "x" },
    ])
    expect(r.ok).toBe(false)
    if (r.ok) return
    const codes = r.failures.map((f) => f.code)
    expect(codes).toContain("patch_absent_for_assigned") // b-2 and c-3 have none
    expect(codes).toContain("patch_not_assigned") // z-9 is not assigned
  })

  test("an EMPTY assigned set refuses rather than submitting nothing", () => {
    const r = buildProMaxSubmission(
      { kind: "model", patches: [] },
      { assignedInstanceIds: [], campaignId: CAMPAIGN },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failures.map((f) => f.code)).toContain("assigned_set_empty")
  })
})
