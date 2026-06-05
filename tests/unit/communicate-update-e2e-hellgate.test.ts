import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, StreamPort } from "@/stream"
import { JsonlRecorder } from "@/stream"
import {
  createCommunicateUpdateTool,
  type ProgressSink,
  type ProgressUpdateMirror,
  type ToolContext,
  ToolRegistry,
} from "@/tool"

/** A capturing StreamPort (collects every AgentEvent). */
class CapturingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/**
 * The HOST adapter (composition-root contract from RFC §4.2): translates the
 * tool-slice `ProgressUpdateMirror` (snake_case, slice-leaf) into a render-only
 * `progress_update` AgentEvent (camelCase) on the EXISTING stream. This is the
 * exact bridge the CLI runtime-context wires; the tool never imports `@/stream`.
 */
const makeProgressAdapter = (stream: StreamPort, turn?: number): ProgressSink => ({
  emit(u: ProgressUpdateMirror): void {
    stream.emit({
      type: "progress_update",
      currentStep: u.current_step,
      ...(u.final_summary !== undefined ? { finalSummary: u.final_summary } : {}),
      ...(u.completed_subtitle !== undefined ? { completedSubtitle: u.completed_subtitle } : {}),
      ...(turn !== undefined ? { turn } : {}),
    })
  },
})

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...over,
})

describe("communicate_update — e2e through the host adapter → stream", () => {
  test("two scripted calls reach the capturing stream in order with the right fields", async () => {
    const stream = new CapturingStream()
    const registry = new ToolRegistry([createCommunicateUpdateTool()])
    const sink = makeProgressAdapter(stream, 1)

    // Call 1 — mid-turn, current_step only.
    await registry.run(
      "communicate_update",
      { current_step: "reading the RFC" },
      ctx({ progressSink: sink }),
    )
    // Call 2 — turn end, the full terminal triple.
    await registry.run(
      "communicate_update",
      {
        current_step: "finalizing",
        final_summary: "Implemented the structured progress channel end to end.",
        completed_subtitle: "Built structured progress channel",
      },
      ctx({ progressSink: sink }),
    )

    const pus = stream.events.filter((e) => e.type === "progress_update")
    expect(pus).toHaveLength(2)
    expect(pus[0]).toEqual({ type: "progress_update", currentStep: "reading the RFC", turn: 1 })
    expect(pus[1]).toEqual({
      type: "progress_update",
      currentStep: "finalizing",
      finalSummary: "Implemented the structured progress channel end to end.",
      completedSubtitle: "Built structured progress channel",
      turn: 1,
    })
  })

  test("the jsonl recorder records progress_update (durable intent) but skips output_progress", () => {
    const dir = mkdtempSync(join(tmpdir(), "comm-upd-"))
    const target = join(dir, "trajectory.jsonl")
    const rec = new JsonlRecorder(target, { now: () => 1, strict: true })

    rec.emit({ type: "progress_update", currentStep: "step a", turn: 2 })
    rec.emit({ type: "output_progress", outputTokens: 42, exact: false })
    rec.emit({
      type: "progress_update",
      currentStep: "step b",
      finalSummary: "done with b",
      completedSubtitle: "Finished step b",
      turn: 2,
    })
    rec.close()

    const lines = readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    const recorded = lines.filter((l) => l.data?.reason === "progress_update")
    expect(recorded).toHaveLength(2)
    expect(recorded[0].kind).toBe("recovery")
    expect(recorded[0].data).toMatchObject({
      reason: "progress_update",
      currentStep: "step a",
      turn: 2,
    })
    expect(recorded[1].data).toMatchObject({
      reason: "progress_update",
      currentStep: "step b",
      finalSummary: "done with b",
      completedSubtitle: "Finished step b",
      turn: 2,
    })
    // output_progress is NEVER recorded (transient token tick).
    expect(lines.some((l) => l.kind === "output_progress")).toBe(false)
  })
})
