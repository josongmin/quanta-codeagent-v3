/**
 * PMX-04 — THE VERDICT PIPELINE, DRIVEN THROUGH THE PRODUCTION COMPOSITION.
 *
 * `chunk-verdicts.ts` was covered only by a test that composed its own pipeline.
 * Production composes it differently: the registry resolves ProMax's
 * `parseBoxGradeVerdicts` port, and `box-session` feeds the result to
 * `bucketsFromGradedInstances` with the chunk's assigned ids.
 *
 * Measured gap that motivated this file: replacing the port with `() => []` left
 * the ENTIRE bench suite green (935 pass). Every ProMax chunk would have reported
 * zero verdicts — indistinguishable from total box loss — with nothing red.
 *
 * So these tests start at `parseFamilyBoxGradeVerdicts(family, text)`, the real
 * function `box-session` calls, which resolves the profile from the real
 * registry. A port that returns nothing, or a profile that forgets to declare
 * one, fails here.
 *
 * They also pin the two ways a pass-rate document can corrupt the count, both of
 * which the receipt path already refuses and the box path did not:
 *
 *   - a DUPLICATE row. `VERDICT_PRECEDENCE` makes `resolved` the strongest
 *     bucket, so any duplicate containing one `success` promoted the instance
 *     over every other verdict for it — a fabricated pass.
 *   - a row for an UNASSIGNED instance, which widened the buckets the coverage
 *     number is computed against.
 */
import { describe, expect, test } from "bun:test"
import { parseFamilyBoxGradeVerdicts } from "@/apps/bench/remote/box-session/family-box-grade"
import { bucketsFromGradedInstances } from "@/apps/bench/remote/verdict-buckets"

const row = (instanceId: string, model: string, golden = "success"): Record<string, unknown> => ({
  instance_id: instanceId,
  language: "c",
  passed: model === "success" && golden === "success",
  model: { final_result: model, raw_reason: model, returncode: 0, script_exit_code: 0 },
  golden: { final_result: golden, raw_reason: golden, returncode: 0, script_exit_code: 0 },
})

const doc = (rows: readonly Record<string, unknown>[]): string => JSON.stringify(rows)

/** EXACTLY what `box-session` does after the on-box grade. */
const chunkVerdicts = (text: string, assigned?: readonly string[]) =>
  bucketsFromGradedInstances(parseFamilyBoxGradeVerdicts("promax", text), assigned)

describe("WIRING — the registry's ProMax port really produces the verdicts", () => {
  test("🔴 a real pass-rate document yields real verdicts through the PORT", () => {
    // RED-ON-INJECTION: set `parseBoxGradeVerdicts: () => []` on the ProMax
    // profile and this fails. Nothing else in the suite did.
    const v = chunkVerdicts(doc([row("a-1", "success"), row("b-2", "non zero exit")]), [
      "a-1",
      "b-2",
    ])
    expect(v.resolved).toEqual(["a-1"])
    expect(v.unresolved).toEqual(["b-2"])
    expect(v.errored).toEqual([])
  })

  test("a family that declares no port REFUSES rather than reporting nothing", () => {
    expect(() => parseFamilyBoxGradeVerdicts("verified", doc([row("a-1", "success")]))).toThrow(
      /parseBoxGradeVerdicts/,
    )
  })
})

describe("a pass-rate document cannot corrupt the count", () => {
  test("🔴 a DUPLICATE row never promotes an instance to resolved", () => {
    // One row says the model missed, another says it passed. The strongest-bucket
    // precedence downstream would take `resolved`; the evaluator emitting two
    // verdicts for one instance is schema drift, and drift must not manufacture
    // a pass.
    const v = chunkVerdicts(doc([row("a-1", "non zero exit"), row("a-1", "success")]), ["a-1"])
    expect(v.resolved).toEqual([])
    expect(v.errored).toEqual(["a-1"])
  })

  test("🔴 a row for an UNASSIGNED instance cannot inflate `resolved`", () => {
    const v = chunkVerdicts(doc([row("a-1", "success"), row("zz-9", "success")]), ["a-1"])
    expect(v.resolved).toEqual(["a-1"])
    // still REPORTED — it is evidence of a manifest/corpus disagreement — but it
    // can never be counted as a resolution the campaign asked for.
    expect(v.errored).toEqual(["zz-9"])
  })

  test("PAIRED CONTROL: the same ids, all assigned, do resolve", () => {
    const v = chunkVerdicts(doc([row("a-1", "success"), row("zz-9", "success")]), ["a-1", "zz-9"])
    expect(v.resolved.sort()).toEqual(["a-1", "zz-9"])
    expect(v.errored).toEqual([])
  })

  test("🔴 an unattributable row does not shrink the denominator", () => {
    // A row with no instance_id is dropped (there is no id to file it under), so
    // the assigned instance it belonged to must still be accounted for.
    const v = chunkVerdicts(
      JSON.stringify([{ language: "c", passed: true, model: {}, golden: {} }]),
      ["a-1"],
    )
    const all = [...v.resolved, ...v.unresolved, ...v.errored, ...v.emptyPatch]
    expect(all).toEqual(["a-1"])
  })
})
