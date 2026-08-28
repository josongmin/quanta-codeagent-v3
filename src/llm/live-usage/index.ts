/**
 * `withLiveUsage` — vendor-agnostic live output-token meter (Claude-Code's
 * rising "· N tokens" spinner counter, ported structurally).
 *
 * # The problem it solves
 *
 * A surface wants to show output tokens climbing WHILE the model streams. But
 * no provider streams an authoritative running count uniformly: the OpenAI
 * Responses surface reports `usage` only once, at `response.completed`;
 * Anthropic reports cumulative `output_tokens` on `message_delta` (one or more
 * times). Wiring this per-adapter would mean N implementations that drift.
 *
 * # Why ONE decorator covers every vendor
 *
 * Every adapter already normalizes its wire stream into the SAME
 * {@link StreamEvent} vocabulary — `text_delta` / `thinking_delta` for content,
 * `usage` for token counts (see `LLMPort`). This decorator sits ABOVE all
 * adapters (composed once at the runner's `composeLLM`) and observes only that
 * normalized vocabulary, so it is blind to vendor and automatically covers any
 * future adapter that honors the port contract.
 *
 * # How the number is derived (honest, no new heuristic)
 *
 *   - estimate     = chars(streamed text + thinking) / 4 — the SAME chars/4
 *                    convention `@/agent/compaction.estimateTokens` uses (the
 *                    divisor is duplicated as a local const to keep `@/llm` from
 *                    importing `@/agent`; the convention is pre-existing, not
 *                    invented here).
 *   - authoritative = the latest `usage.outputTokens` the inner adapter emitted
 *                    (provider truth; for Anthropic this climbs as intermediate
 *                    `message_delta`s arrive — see the adapter's non-terminal
 *                    usage emit).
 *   - displayed    = max(authoritative, estimate) — monotonic, never regresses.
 *   - `exact`      = authoritative >= estimate, i.e. the provider's own count
 *                    already accounts for everything streamed so far. A UI may
 *                    render `~N` when `exact` is false (the tail is estimated).
 *
 * # Emission contract
 *
 *   - Pass EVERY inner event through unchanged (this is a transparent tee).
 *   - After a content/usage event, emit ONE `output_progress` iff the displayed
 *     count changed (so a burst of tiny deltas can't flood consumers).
 *   - `stream_reset` (a {@link FallbackLLM} provider switch) resets the
 *     accumulators so the count restarts with the replacement stream.
 *   - `output_progress` is transient UI signal — the loop forwards it WITHOUT
 *     touching the recorder / budget (terminal `usage` owns accounting), and
 *     the trajectory recorder skips it. See the event's doc in `@/llm/types`.
 *
 * # Default-OFF
 *
 * `knobs.enabled !== true` ⇒ the inner port is returned VERBATIM (identity —
 * zero allocation, byte-identical stream). The surface opts in (the CLI ties it
 * to the turn-indicator being enabled, i.e. an interactive TTY).
 */

import { forwardPortIdentity } from "../port-identity"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"

/** chars/token divisor — mirrors `@/agent/compaction.estimateTokens` (which
 *  computes `Math.ceil(chars / 4)`). Duplicated rather than imported to keep
 *  the `@/llm` slice free of an `@/agent` dependency. */
const CHARS_PER_TOKEN = 4

/** Estimate tokens from an accumulated character count using the chars/4
 *  convention. Exported for the hellgate to pin parity with `estimateTokens`. */
export const estimateTokensFromChars = (chars: number): number =>
  chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN)

/** Closed knob set. exactOptional: omitted fields must be absent (never
 *  `undefined`-set), mirroring the convention used by `LLMRetryKnobs`. */
export interface LiveUsageKnobs {
  /** Default-OFF (`false`). When not `true`, `withLiveUsage` returns the inner
   *  port verbatim (identity decorator, byte-identical stream). */
  readonly enabled?: boolean
}

/** Copy the optional passthrough identity fields from an inner port. Keeps the
 *  decorated port indistinguishable from the inner for telemetry / renderer. */
const passthroughFields = (inner: LLMPort): Omit<LLMPort, "stream"> => ({
  ...forwardPortIdentity(inner),
})

/**
 * Decorate an inner {@link LLMPort} so its stream additionally yields
 * `output_progress` events tracking live output-token growth.
 *
 * @param inner the port to wrap (any adapter or composed decorator stack).
 * @param knobs `{ enabled }` — default-OFF; when off, `inner` is returned as-is.
 */
export const withLiveUsage = (inner: LLMPort, knobs: LiveUsageKnobs | undefined): LLMPort => {
  if (knobs?.enabled !== true) return inner
  return {
    ...passthroughFields(inner),
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      // Per-stream accumulators. A `stream_reset` (fallback provider switch)
      // zeroes them so the replacement stream starts a fresh count.
      let chars = 0
      let authoritative = 0
      let lastEmitted = -1
      let lastExact = false
      for await (const ev of inner.stream(input)) {
        yield ev
        switch (ev.type) {
          case "stream_reset":
            chars = 0
            authoritative = 0
            lastEmitted = -1
            lastExact = false
            continue
          case "text_delta":
            chars += ev.delta.length
            break
          case "thinking_delta":
            chars += ev.text.length
            break
          case "tool_use_delta":
            // Streamed tool-call argument JSON is generated output too — the
            // provider bills it as output tokens, so a long tool-call payload
            // must keep the counter climbing (not freeze on the last text).
            chars += ev.delta.length
            break
          case "usage":
            // Provider-authoritative cumulative output count (monotonic — guard
            // against a non-monotonic adapter by never letting it regress).
            authoritative = Math.max(authoritative, ev.outputTokens)
            break
          case "output_progress":
            // An inner adapter already produced an authoritative live count
            // (e.g. Anthropic intermediate `message_delta`). It was passed
            // through above; absorb its value as authoritative so our own
            // estimate-based emits stay monotonic and consistent. Do NOT emit a
            // duplicate for this tick.
            authoritative = Math.max(authoritative, ev.outputTokens)
            continue
          default:
            // Any other event leaves the counter unchanged — emit nothing.
            continue
        }
        const estimate = estimateTokensFromChars(chars)
        const outputTokens = Math.max(authoritative, estimate)
        // `exact` ⇔ the provider's own count already covers all streamed
        // content (no estimated tail). False while we extrapolate ahead of the
        // last authoritative number (or before any usage arrived at all).
        const exact = authoritative >= estimate && authoritative > 0
        // Emit on a change in the displayed count OR in exactness — the latter
        // so an estimate that an authoritative `usage` later CONFIRMS at the
        // same value still surfaces the `exact:false → true` upgrade to a
        // consumer that only reads `output_progress`. Skip the zero reading
        // (e.g. a provider's initial `usage:{output:0}`) — a "0 tokens"
        // progress is pure noise the UI renders as nothing.
        if (outputTokens > 0 && (outputTokens !== lastEmitted || exact !== lastExact)) {
          lastEmitted = outputTokens
          lastExact = exact
          yield { type: "output_progress", outputTokens, exact }
        }
      }
    },
  }
}
