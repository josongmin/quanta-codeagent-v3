import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { CaptureStream } from "./capture-stream"
import type { ExpectSpec, TrajectoryEntry } from "./types"

/**
 * `LLMPort` decorator that tees every streamed event into a `(run, turn)`-keyed
 * trajectory log while forwarding the stream unchanged. Drives record mode:
 * wrap the real provider adapter, run the scenario, then serialize
 * {@link captured} to `trajectory.jsonl`.
 *
 * Mirrors `TrajectoryReplayLLM`'s cursor contract (`nextRun()` between prompts)
 * so it satisfies the same `SmokeLLM` shape `runConversation` expects.
 */
export class RecordingLLM implements LLMPort {
  readonly model?: string
  readonly captured: TrajectoryEntry[] = []
  private run = 0
  private turn = 0

  constructor(private readonly inner: LLMPort) {
    if (inner.model !== undefined) this.model = inner.model
  }

  nextRun(): void {
    this.run += 1
    this.turn = 0
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const run = this.run
    const turn = this.turn
    this.turn += 1
    for await (const ev of this.inner.stream(input)) {
      this.captured.push({ run, turn, event: ev as unknown as Record<string, unknown> })
      yield ev
    }
  }
}

/** Serialize a captured trajectory to JSONL (one entry per line). */
export const serializeTrajectory = (entries: readonly TrajectoryEntry[]): string =>
  `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`

/**
 * Derive a conservative `expect.json` PROPOSAL from an observed run. Encodes
 * only what is safe to assert from a single recording:
 *   - exact `stopReason` and `turns.count`
 *   - `toolCalls.required` = the distinct tools observed
 *   - `toolCalls.counts`   = exact observed counts (min == max)
 * Text/file assertions are intentionally left for the author — a single run is
 * too thin to mine reliable text invariants without overfitting.
 */
export const proposeExpect = (args: {
  capture: CaptureStream
  stopReason: string
  turns: number
}): ExpectSpec => {
  const counts = args.capture.toolCallCounts()
  const required = Object.keys(counts).sort()
  const countSpec: Record<string, { min: number; max: number }> = {}
  for (const [name, n] of Object.entries(counts)) countSpec[name] = { min: n, max: n }
  const stopReason = args.stopReason as ExpectSpec["stopReason"]
  return {
    ...(stopReason !== undefined ? { stopReason } : {}),
    turns: { count: { min: args.turns, max: args.turns } },
    toolCalls: {
      ...(required.length > 0 ? { required } : {}),
      ...(required.length > 0 ? { counts: countSpec } : {}),
    },
  }
}

/** Render a human-readable field-level diff between an existing expect spec and
 *  a freshly proposed one. Returns an empty string when they agree on the
 *  proposed fields. */
export const diffExpect = (existing: ExpectSpec, proposed: ExpectSpec): string => {
  const lines: string[] = []
  const cmp = (path: string, a: unknown, b: unknown): void => {
    const sa = JSON.stringify(a)
    const sb = JSON.stringify(b)
    if (sa !== sb) lines.push(`  ${path}\n    existing: ${sa}\n    observed: ${sb}`)
  }
  cmp("stopReason", existing.stopReason, proposed.stopReason)
  cmp("turns.count", existing.turns?.count, proposed.turns?.count)
  cmp("toolCalls.required", existing.toolCalls?.required, proposed.toolCalls?.required)
  cmp("toolCalls.counts", existing.toolCalls?.counts, proposed.toolCalls?.counts)
  return lines.join("\n")
}
