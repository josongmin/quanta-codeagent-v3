/**
 * PMX-04 — A DUPLICATE SUBMITTED PATCH IS REFUSED, NOT SILENTLY LAST-WON.
 *
 * `buildProMaxSubmission` collapsed `submission.patches` into a `Map` before the
 * serializer ever saw them:
 *
 *     for (const p of submission.patches) byId.set(p.instanceId, p)
 *
 * So two rows for one instance kept the LAST and discarded the first, with no
 * failure and no record of which patch was graded. The module's own doc claimed
 * duplicate ids were "already `serializeProMaxPredictions`'s job" — but that
 * serializer only ever received `assigned.map(...)`, which is unique by
 * construction, so its `instance_id_duplicated` refusal could never fire on this
 * path.
 *
 * This is not hypothetical bookkeeping. Concatenate two shard prediction files,
 * or export a best-of-N run, and the gate grades one arbitrarily-chosen patch per
 * instance while reporting a clean `coverage 1`. Which patch produced the number
 * is unrecoverable.
 *
 * Refusing is right rather than de-duplicating: the caller knows which patch it
 * meant, and picking one for them is exactly how the record was lost.
 */
import { describe, expect, test } from "bun:test"
import { buildProMaxSubmission } from "@/apps/bench/harness/promax/submission"

const ASSIGNED = ["a-1", "b-2"] as const
const CAMPAIGN = "pmx-dup-probe"

const submit = (patches: readonly { instanceId: string; modelPatch: string }[]) =>
  buildProMaxSubmission(
    { kind: "model", patches },
    { assignedInstanceIds: ASSIGNED, campaignId: CAMPAIGN },
  )

describe("duplicate submitted patches", () => {
  test("🔴 two patches for ONE instance REFUSE", () => {
    const r = submit([
      { instanceId: "a-1", modelPatch: "FIRST" },
      { instanceId: "a-1", modelPatch: "SECOND" },
      { instanceId: "b-2", modelPatch: "OK" },
    ])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failures.map((f) => f.code)).toContain("patch_duplicated")
    expect(r.failures.map((f) => f.message).join(" ")).toContain("a-1")
  })

  test("🔴 the refusal is not silently repaired by keeping one", () => {
    // The old behaviour: ok:true with SECOND kept and FIRST gone.
    const r = submit([
      { instanceId: "a-1", modelPatch: "FIRST" },
      { instanceId: "a-1", modelPatch: "SECOND" },
      { instanceId: "b-2", modelPatch: "OK" },
    ])
    expect(r.ok, "a duplicate was accepted — one patch was discarded unrecorded").toBe(false)
  })

  test("IDENTICAL duplicates are refused too — the caller still meant something", () => {
    // Same bytes twice is still a malformed submission (two shards claiming the
    // same instance), and silently accepting it teaches that duplicates are fine.
    const r = submit([
      { instanceId: "a-1", modelPatch: "SAME" },
      { instanceId: "a-1", modelPatch: "SAME" },
      { instanceId: "b-2", modelPatch: "OK" },
    ])
    expect(r.ok).toBe(false)
  })

  test("PAIRED CONTROL: one patch per assigned instance is accepted", () => {
    const r = submit([
      { instanceId: "a-1", modelPatch: "X" },
      { instanceId: "b-2", modelPatch: "Y" },
    ])
    expect(r.ok).toBe(true)
  })

  test("the gold-sentinel path is unaffected — it builds its own unique rows", () => {
    const r = buildProMaxSubmission(
      { kind: "gold-sentinel" },
      { assignedInstanceIds: ASSIGNED, campaignId: CAMPAIGN },
    )
    expect(r.ok).toBe(true)
  })
})

describe("the tool's own predictions reader", () => {
  test("🔴 a duplicated instance_id in the predictions FILE is refused there too", async () => {
    const { readModelPatches } = await import("../../../../../tools/bench-promax/run-gate")
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "promax-dup-preds-"))
    try {
      const path = join(dir, "preds.json")
      writeFileSync(
        path,
        JSON.stringify([
          { instance_id: "a-1", model_patch: "FIRST" },
          { instance_id: "a-1", model_patch: "SECOND" },
        ]),
      )
      // Caught at the FILE boundary, not only after the assigned-set reconcile:
      // the operator's mistake is in the file they passed, and that is where the
      // message is useful.
      expect(() => readModelPatches(path)).toThrow(/a-1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
