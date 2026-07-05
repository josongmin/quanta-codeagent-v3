/**
 * Structural TDD (HELLGATE step 5) — gaps the behavioural tests don't pin:
 *  - a REAL-shaped trajectory event (all producer fields) is structurally
 *    assignable to the local {@link MetricEvent} mirror (the load-bearing claim
 *    that a live array feeds these fns unchanged);
 *  - interleaved non-target kinds (assistant_text / tool_result / patch_generated)
 *    are ignored, never throw;
 *  - determinism: same input ⇒ identical output.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import type { ObservationBundle } from "@/agent/observation/fragment"
import {
  classifyFailure,
  hintFollowWithoutVerifyRate,
  type MetricEvent,
  ownerEditHitRate,
  stratumTag,
} from "@/agent/observation/metrics"
import { bundle, edit, owner, read, resetSeq } from "./fixtures"

beforeEach(resetSeq)

const OWNER = "pkg/a.py"
const b: ObservationBundle = bundle([owner(OWNER)])

describe("structural: real-shaped trajectory event assignability", () => {
  test("a full producer-shaped event (extra fields) is accepted as MetricEvent", () => {
    // Mirrors src/shared/trajectory.ts TrajectoryEvent — extra fields are inert.
    const realShaped: MetricEvent = {
      schema: "quanta.trajectory.v1",
      v: 1,
      seq: 7,
      ts: 123,
      ctx: { runId: "r1" },
      producer: { name: "quanta", version: "0.0.0" },
      redaction: { policy: "secrets.v1", applied: true },
      kind: "tool_call",
      data: { id: "c1", name: "edit", input: { path: OWNER } },
    } as MetricEvent
    const r = ownerEditHitRate([realShaped], b)
    expect(r).toMatchObject({ applicable: true, rate: 1 })
  })
})

describe("structural: interleaved non-target kinds are ignored (no throw)", () => {
  test("assistant_text / tool_result / patch_generated between calls are skipped", () => {
    const events: MetricEvent[] = [
      { kind: "session_start", data: {} },
      { kind: "assistant_text", data: { delta: "thinking" } },
      read(OWNER),
      { kind: "tool_result", data: { name: "read", ok: true } },
      { kind: "assistant_text", data: { delta: "editing" } },
      edit(OWNER),
      { kind: "patch_generated", data: { diffPath: "x", filesChanged: 1 } },
    ]
    // read-before-edit present ⇒ NOT follow-without-verify.
    expect(hintFollowWithoutVerifyRate(events, b).rate).toBe(0)
  })

  test("malformed events (missing data / null input) do not throw", () => {
    const junk: MetricEvent[] = [
      { kind: "tool_call" },
      { kind: "tool_call", data: {} },
      { kind: "tool_call", data: { name: "edit", input: null as unknown as undefined } },
      { kind: "tool_call", data: { name: "edit", input: { path: OWNER } } },
    ]
    expect(() => ownerEditHitRate(junk, b)).not.toThrow()
    expect(ownerEditHitRate(junk, b)).toMatchObject({ applicable: true, rate: 1 })
  })
})

describe("structural: determinism", () => {
  test("same input ⇒ byte-identical output across metrics", () => {
    const events = [read(OWNER), edit(OWNER)]
    const inputs = { passed: false, successPatchFiles: ["pkg/b.py"] }
    const a1 = JSON.stringify(classifyFailure(events, b, inputs))
    const a2 = JSON.stringify(classifyFailure(events, b, inputs))
    expect(a1).toBe(a2)
    expect(JSON.stringify(stratumTag({ goldPatchFiles: ["a.py", "b.py"] }))).toBe(
      JSON.stringify(stratumTag({ goldPatchFiles: ["a.py", "b.py"] })),
    )
  })
})
