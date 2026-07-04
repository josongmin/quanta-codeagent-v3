/**
 * `@/sdk/testing` — deterministic, network-free test harness for embed
 * consumers (Phase 6).
 *
 * Fence-legal: imports ONLY types from `@/llm` / `@/stream` (no `@/apps/**`),
 * so `src/sdk`'s `surfaceIsolationOnly` invariant holds. Mirrors the
 * headless `FakeLlm`, exposed here as the SDK's public double.
 */

import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"

/** One scripted assistant turn: either a plain text reply (widened to the
 *  canonical `text_delta + message_stop` shape) or a raw `StreamEvent[]` for
 *  tool-call / multi-block turns. */
export type FakeCompletion = { readonly text: string } | { readonly events: readonly StreamEvent[] }

const scriptFromCompletion = (c: FakeCompletion): StreamEvent[] => {
  if ("events" in c) return [...c.events]
  return [
    { type: "text_delta", delta: c.text },
    { type: "message_stop", stop_reason: "end_turn" },
  ]
}

/** Pre-programmed `LLMPort`. CONSUMES one script per assistant turn in order
 *  (`shift`) — provide ONE completion per turn you expect (e.g. turn 1 = a
 *  tool_use script, turn 2 = the final completion). When the list is EXHAUSTED it
 *  does NOT replay the last script; it emits a terminal `end_turn` so the loop
 *  stops deterministically (replaying a tool_use forever would run to `maxTurns`).
 *  `seen` exposes the per-turn `StreamInput`s for assertions. */
class FakeLlm implements LLMPort {
  readonly model = "sdk-fake"
  readonly provider = "fake"
  readonly authMode = "fake"
  readonly seen: StreamInput[] = []
  private readonly scripts: StreamEvent[][]

  constructor(completions: readonly FakeCompletion[]) {
    this.scripts = completions.map(scriptFromCompletion)
    if (this.scripts.length === 0) {
      throw new Error("fakeLlm requires at least one completion")
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    const next = this.scripts.shift()
    if (next !== undefined) {
      yield* next
      return
    }
    // Script exhausted. Fail SAFE, not silent: emit a terminal end_turn so the
    // loop stops. Replaying the last turn forever (its shape may be a tool_use
    // with no terminator) would run to `maxTurns` — a nondeterministic-cost
    // runaway, the opposite of what a determinism harness wants.
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Build a scripted {@link LLMPort} that replays `completions` with zero
 *  network. Pass to `createAnalysisAgent({ llm: fakeLlm([...]) })`. */
export const fakeLlm = (completions: readonly FakeCompletion[]): LLMPort => new FakeLlm(completions)

/** A {@link StreamPort} that records every emitted {@link AgentEvent} for
 *  post-run assertions on the event sequence. */
export class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}
