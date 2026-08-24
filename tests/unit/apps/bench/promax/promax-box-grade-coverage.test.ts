/**
 * PMX-04 — AN INSTANCE THE ON-BOX EVALUATOR NEVER REPORTED ON MUST NOT VANISH.
 *
 * The pinned evaluator iterates the PREDICTIONS and looks golden up by id
 * (`test_run.py`, measured):
 *
 *     golden_entry = golden_lookup.get(instance_id)
 *     if golden_entry is None:
 *         continue          # in preds, absent from golden -> silently skipped
 *
 * So an instance can be submitted and come back with NO ROW AT ALL — not a
 * failure row, no row. The same is true when the evaluator dies part-way, when
 * patch-gen produced no predictions file, and when a manifest names an id the
 * pinned dataset does not carry.
 *
 * On the LOCAL gate path that is already caught: the official receipt derives
 * `missing` from assigned-minus-reported, and the campaign gate refuses a run
 * with any `missing`. The BOX path had no such reconciliation — it projected the
 * rows that existed and said nothing about the ones that did not, so those
 * instances left the chunk's accounting silently.
 *
 * A silent vanish is worse than a failure: it shrinks the denominator, so the
 * remaining instances look like a larger share of a smaller set, and the run
 * still reads as clean.
 *
 * THE RULE: an assigned instance with no row is `errored`, never `unresolved`.
 * "The evaluator produced no verdict" is a claim about the INFRASTRUCTURE. Filing
 * it as `unresolved` would assert the model was measured and missed.
 */
import { describe, expect, test } from "bun:test"
import { bucketsFromGradedInstances } from "@/apps/bench/remote/verdict-buckets"

const ASSIGNED = ["repo__a-1", "repo__b-2", "repo__c-3"] as const

describe("assigned-set reconciliation on the on-box grade", () => {
  test("KNOWN-ITEM FLOOR: full coverage is unchanged by reconciliation", () => {
    const v = bucketsFromGradedInstances(
      [
        { instanceId: "repo__a-1", state: "resolved" },
        { instanceId: "repo__b-2", state: "model_miss" },
        { instanceId: "repo__c-3", state: "infra_invalid" },
      ],
      ASSIGNED,
    )
    expect(v.resolved).toEqual(["repo__a-1"])
    expect(v.unresolved).toEqual(["repo__b-2"])
    expect(v.errored).toEqual(["repo__c-3"])
  })

  test("🔴 an assigned instance with NO row is reported as `errored`, not dropped", () => {
    const v = bucketsFromGradedInstances([{ instanceId: "repo__a-1", state: "resolved" }], ASSIGNED)
    // b-2 and c-3 were assigned and never reported on
    expect(v.errored.sort()).toEqual(["repo__b-2", "repo__c-3"])
    // …and NOT filed against the model
    expect(v.unresolved).toEqual([])
  })

  test("🔴 COVERING PARTITION: every assigned id lands in exactly one bucket", () => {
    const v = bucketsFromGradedInstances(
      [{ instanceId: "repo__b-2", state: "model_miss" }],
      ASSIGNED,
    )
    const all = [...v.resolved, ...v.unresolved, ...v.errored, ...v.emptyPatch]
    expect(all.sort()).toEqual([...ASSIGNED].sort())
    expect(new Set(all).size).toBe(all.length)
  })

  test("🔴 the empty artifact case — nothing reported ⇒ every assigned id is `errored`", () => {
    // This is the shape a failed patch-gen or a dead evaluator produces. It must
    // read as a total INFRA failure, never as an empty (and therefore clean) run.
    const v = bucketsFromGradedInstances([], ASSIGNED)
    expect(v.errored.sort()).toEqual([...ASSIGNED].sort())
    expect(v.resolved).toEqual([])
    expect(v.unresolved).toEqual([])
  })

  test("a row for an UNASSIGNED instance is REPORTED but quarantined", () => {
    // Discarding it would hide a manifest/corpus disagreement, and the id is real
    // evidence — but counting it as a resolution would widen the very set that
    // coverage is measured against, so it is reported as an error instead.
    const v = bucketsFromGradedInstances(
      [
        { instanceId: "repo__a-1", state: "resolved" },
        { instanceId: "repo__z-9", state: "resolved" },
      ],
      ASSIGNED,
    )
    expect(v.resolved).toEqual(["repo__a-1"])
    expect(v.errored).toContain("repo__z-9")
  })

  test("PAIRED CONTROL: with NO assigned set given, behaviour is exactly as before", () => {
    // Every other family passes no assigned set; reconciliation must be opt-in so
    // their accounting is byte-identical.
    const v = bucketsFromGradedInstances([{ instanceId: "repo__a-1", state: "resolved" }])
    expect(v.resolved).toEqual(["repo__a-1"])
    expect(v.errored).toEqual([])
  })
})
