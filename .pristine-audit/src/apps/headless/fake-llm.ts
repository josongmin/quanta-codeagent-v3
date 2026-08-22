/**
 * `@/apps/headless/fake-llm` — minimal pre-programmed `LLMPort` impl.
 *
 * Used by the headless surface (and the hellgate test) to drive `runOnce`
 * end-to-end without touching the network. Replays a fixed list of
 * `StreamEvent[]` scripts, one per assistant turn, in order. A subsequent
 * turn beyond the script list replays the LAST script (the typical
 * tool-call → tool-result → completion shape works out of the box: turn 1
 * issues the tool, turn 2 completes).
 *
 * Plane-clean: only imports types from `@/llm`. No `@/apps/*` import; no
 * env/argv reads; no IO.
 */

import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { FakeCompletion } from "./types"

/** Widen a {@link FakeCompletion} into the concrete `StreamEvent[]` script
 *  the loop consumes. `{text:"pong"}` becomes the canonical "model said pong"
 *  shape (`text_delta + message_stop("end_turn")`) — byte-identical to the
 *  shape every real provider adapter would emit for a one-shot text answer. */
export const scriptFromCompletion = (c: FakeCompletion): StreamEvent[] => {
  if ("events" in c) return [...c.events]
  return [
    { type: "text_delta", delta: c.text },
    { type: "message_stop", stop_reason: "end_turn" },
  ]
}

/** Pre-programmed LLM port. The `seen` array is exposed so a caller (or the
 *  hellgate test) can assert which `StreamInput`s the fake actually saw —
 *  the same observability pattern the per-turn unit tests use. */
export class FakeLlm implements LLMPort {
  readonly model = "headless-fake"
  readonly provider = "headless"
  readonly authMode = "fake"
  readonly seen: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []

  constructor(completions: readonly FakeCompletion[]) {
    this.scripts = completions.map(scriptFromCompletion)
    // Defensive: an empty script list would cause `last` to stay `[]` and
    // every turn would silently yield nothing — surface that as a thrown
    // error at construction time instead of a hang at the first turn.
    if (this.scripts.length === 0) {
      throw new Error("FakeLlm requires at least one fake completion")
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const ev of script) yield ev
  }
}
