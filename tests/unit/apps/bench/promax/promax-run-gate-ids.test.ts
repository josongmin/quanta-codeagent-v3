/**
 * PMX-04 — `--ids` MAY NARROW THE RUN, BUT NEVER SILENTLY.
 *
 * `--ids` replaced the campaign's assigned set outright, with nothing compared
 * against the golden file. Two consequences, both measured:
 *
 *  1. An id the golden does not carry was accepted. The pinned evaluator looks
 *     golden up by id and skips what it cannot find (`if golden_entry is None:
 *     continue`), so such an instance can NEVER produce a row — it is a typo, not
 *     a selection, and it is refused rather than graded as `missing` twenty
 *     minutes later.
 *  2. `--ids a` on a 170-instance campaign printed `assigned 1 | coverage 1` and
 *     exited 0. Nothing in that output says it is one instance out of 170, so a
 *     narrowed probe reads exactly like a clean full gate.
 *
 * The stated guard was PMX-06's sample-identity clause — which only runs if the
 * operator separately invokes `campaign-gates.ts`. A number that reads as a pass
 * on its own must not depend on someone remembering a second command.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRunGateInput, renderNarrowedNote } from "../../../../../tools/bench-promax/run-gate"

const TEMP: string[] = []
const goldenWith = (ids: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "promax-gate-ids-"))
  TEMP.push(dir)
  const path = join(dir, "campaign-golden.json")
  writeFileSync(path, JSON.stringify(ids.map((id) => ({ instance_id: id, patch: "GOLD" }))))
  return path
}

const argv = (goldenPath: string, ids?: string): readonly string[] => [
  "--campaign",
  "c1",
  "--pinned-root",
  "/pinned",
  "--golden",
  goldenPath,
  "--work-dir",
  "/work",
  "--python",
  "/venv/bin/python",
  ...(ids === undefined ? [] : ["--ids", ids]),
]

describe("--ids is checked against the golden", () => {
  test("KNOWN-ITEM FLOOR: a subset of the golden's ids is accepted, in the order given", () => {
    const g = goldenWith(["a-1", "b-2", "c-3"])
    const input = buildRunGateInput(argv(g, "c-3,a-1"))
    expect([...input.assignedInstanceIds]).toEqual(["c-3", "a-1"])
  })

  test("🔴 an id the GOLDEN does not carry is REFUSED", () => {
    const g = goldenWith(["a-1", "b-2"])
    expect(() => buildRunGateInput(argv(g, "a-1,zz-9"))).toThrow(/zz-9/)
  })

  test("the refusal explains that such an instance can never be graded", () => {
    const g = goldenWith(["a-1"])
    let message = ""
    try {
      buildRunGateInput(argv(g, "zz-9"))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/golden/i)
    expect(message).toMatch(/never|cannot|skips/i)
  })

  test("PAIRED CONTROL: with NO --ids the whole golden is assigned", () => {
    const g = goldenWith(["a-1", "b-2", "c-3"])
    expect(buildRunGateInput(argv(g)).assignedInstanceIds).toHaveLength(3)
  })
})

describe("a narrowed run says so in its own output", () => {
  test("🔴 narrowing is stated, with both numbers", () => {
    const note = renderNarrowedNote(2, 170)
    expect(note).not.toBeUndefined()
    expect(note ?? "").toContain("2")
    expect(note ?? "").toContain("170")
    expect(note ?? "").toMatch(/subset|narrow|not the campaign/i)
  })

  test("PAIRED CONTROL: a full run adds no note", () => {
    expect(renderNarrowedNote(170, 170)).toBeUndefined()
  })
})

// `afterAll`, NOT `process.on("exit")`. Bun's test runner does not fire an
// exit hook for a test file, so that form never ran and every fixture dir it
// created stayed on disk — enough of them to make `ls /tmp` slow enough to
// time other tests out.
afterAll(() => {
  for (const dir of TEMP) rmSync(dir, { recursive: true, force: true })
})

describe("WIRING — the narrowing note reaches the operator's actual output", () => {
  test("🔴 a narrowed run's rendered output carries the note", async () => {
    const { runGateCli } = await import("../../../../../tools/bench-promax/run-gate")
    const g = goldenWith(["a-1", "b-2", "c-3"])
    // The gate itself refuses early (no pinned checkout here) — that is fine: the
    // claim is that the NOTE is appended to whatever this tool prints, and a
    // refusal is exactly when an operator is reading closely.
    const out = runGateCli(argv(g, "a-1")).output
    expect(out).toMatch(/NARROWED RUN/)
    expect(out).toContain("3")
  })

  test("PAIRED CONTROL: a full run's output carries no note", async () => {
    const { runGateCli } = await import("../../../../../tools/bench-promax/run-gate")
    const g = goldenWith(["a-1", "b-2", "c-3"])
    expect(runGateCli(argv(g)).output).not.toMatch(/NARROWED RUN/)
  })
})
