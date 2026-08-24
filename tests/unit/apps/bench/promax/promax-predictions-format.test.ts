/**
 * PMX-04 — THE BOX WRITES JSONL; THE PINNED EVALUATOR READS A JSON ARRAY.
 *
 * `writePredictions` (the bench's own writer, used by every family) emits JSONL:
 *
 *     rows.map((r) => JSON.stringify(r)).join("\n")
 *
 * `test_run.py` reads it with `json.load(f)`. Measured against the pinned source:
 *
 *   - two or more instances  → `json.load` raises; the evaluator dies
 *   - exactly one instance   → it parses as a DICT, and the evaluator then does
 *                              `pred_entries = list(pred_data.values())`, i.e. the
 *                              instance id and the patch as bare STRINGS. Nothing
 *                              has `.get("instance_id")`, so zero jobs are built.
 *
 * Either way the grade produces nothing, and ProMax's JSON-ARRAY contract is the
 * family's DEFINING difference — `run-gate.ts` already refuses a non-array with
 * "ProMax predictions are an array of {instance_id, model_patch}, not the JSONL
 * other families use". The box path was handing it exactly that JSONL.
 *
 * So the box's predictions are CONVERTED through the family's own serializer
 * before the evaluator sees them. That is not just a reformat: it routes the box
 * path through `serializeProMaxPredictions`, whose duplicate-id and blank-id
 * refusals and whose explicit two-field projection (the guard that keeps a
 * gold-bearing `patch` field out of the file the evaluator reads) were otherwise
 * reachable only from the local gate.
 */
import { describe, expect, test } from "bun:test"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"

const jsonl = (rows: readonly Record<string, unknown>[]): string =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`

const prepare = (text: string): string => {
  const port = resolveDatasetFamilyProfile("promax").prepareBoxGradePredictions
  if (port === undefined) throw new Error("promax declares no prepareBoxGradePredictions")
  return port(text)
}

describe("the box's JSONL predictions become ProMax's JSON array", () => {
  test("🔴 KNOWN-ITEM FLOOR: multi-row JSONL becomes a parseable JSON ARRAY", () => {
    const out = prepare(
      jsonl([
        { instance_id: "a-1", model_patch: "PATCH-A" },
        { instance_id: "b-2", model_patch: "PATCH-B" },
      ]),
    )
    const parsed = JSON.parse(out) as { instance_id: string; model_patch: string }[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((r) => r.instance_id)).toEqual(["a-1", "b-2"])
    expect(parsed.map((r) => r.model_patch)).toEqual(["PATCH-A", "PATCH-B"])
  })

  test("🔴 the SINGLE-row case — the one that parsed as a dict and produced zero jobs", () => {
    const out = prepare(jsonl([{ instance_id: "a-1", model_patch: "ONLY" }]))
    const parsed = JSON.parse(out) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as { instance_id: string }[])[0]?.instance_id).toBe("a-1")
  })

  test("🔴 a GOLD-BEARING extra field cannot ride into the file the evaluator reads", () => {
    // The projection is explicit, not a spread. A row carrying `patch` (the answer
    // key) or a trajectory must lose them here.
    const out = prepare(
      jsonl([
        { instance_id: "a-1", model_patch: "MINE", patch: "GOLD-ANSWER", test_patch: "GOLD-TEST" },
      ]),
    )
    expect(out).not.toContain("GOLD-ANSWER")
    expect(out).not.toContain("GOLD-TEST")
    expect(out).toContain("MINE")
  })

  test("🔴 a DUPLICATE instance id REFUSES — it is what fabricates a pass downstream", () => {
    // Two rows for one id let the strongest-bucket precedence promote whichever
    // row said `success`. The serializer's `instance_id_duplicated` refusal was
    // unreachable from the box path until the conversion routed through it.
    expect(() =>
      prepare(
        jsonl([
          { instance_id: "a-1", model_patch: "FIRST" },
          { instance_id: "a-1", model_patch: "SECOND" },
        ]),
      ),
    ).toThrow(/duplicat/i)
  })

  test("an EMPTY patch survives the conversion — it is a measurement, not a hole", () => {
    const out = prepare(jsonl([{ instance_id: "a-1", model_patch: "" }]))
    const parsed = JSON.parse(out) as { model_patch: string }[]
    expect(parsed[0]?.model_patch).toBe("")
  })

  test("blank lines and a trailing newline are tolerated — that is what JSONL looks like", () => {
    const out = prepare(`{"instance_id":"a-1","model_patch":"X"}\n\n`)
    expect((JSON.parse(out) as unknown[]).length).toBe(1)
  })

  test("PAIRED CONTROL: an inline-grading family declares no such conversion", () => {
    expect(resolveDatasetFamilyProfile("verified").prepareBoxGradePredictions).toBeUndefined()
  })
})
