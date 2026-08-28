import { forwardPortIdentity } from "./port-identity"
import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

/**
 * SOLID decorator: wrap an {@link LLMPort} so every `stream()` call carries a
 * per-port RECORDING LANE label. The bench runs N candidates (repair-breadth,
 * verify-select, location fanout) CONCURRENTLY through ONE shared recording
 * port, so without a lane label their turns interleave indistinguishably on the
 * single tape. This decorator stamps the lane onto each request; the recorder
 * strips it from the stored request (REPLAY-NEUTRAL — never hashed) and lifts it
 * into `metadata.lane`, so a debugger can group the one interleaved tape by lane.
 *
 *   - DIP: depends only on the {@link LLMPort} interface — composes over any
 *     adapter or further decorator (temperature, recorder) without knowing the
 *     concrete type.
 *   - OCP: adapters are untouched; behaviour extended by composition. The label
 *     reaches the recorder via `StreamInput.recordingLane` (absent ⇒
 *     byte-identical, no key on the wire, no `lane` in metadata).
 *   - SRP: injects exactly ONE field. Maps no events, holds no state.
 *
 * Caller override is RESPECTED: an already-set `input.recordingLane` wins, so an
 * outer wrap (a finer lane) is not clobbered by an inner one.
 */
export const laneLabeledPort = (inner: LLMPort, lane: string): LLMPort => ({
  // Delegate the descriptive surface verbatim — only the recording lane changes.
  ...forwardPortIdentity(inner),
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const next: StreamInput =
      input.recordingLane !== undefined ? input : { ...input, recordingLane: lane }
    return inner.stream(next)
  },
})
