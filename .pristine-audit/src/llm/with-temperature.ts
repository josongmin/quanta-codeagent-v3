import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

/**
 * SOLID decorator: wrap an {@link LLMPort} so every `stream()` call carries a
 * per-port sampling `temperature` (repair-breadth fanout diversity).
 *
 *   - DIP: depends only on the {@link LLMPort} interface — works over any
 *     adapter or further decorator without knowing the concrete type.
 *   - OCP: the wrapped adapters are untouched; behaviour is extended by
 *     composition. The temperature reaches the wire via `StreamInput.temperature`
 *     (each adapter spreads it conditionally — absent ⇒ byte-identical).
 *   - SRP: this decorator does exactly ONE thing — inject the temperature into
 *     the input. It maps no events and holds no state.
 *
 * Caller override is RESPECTED: when `input.temperature` is already set, that
 * value wins (the per-call seam takes precedence over the per-port default), so
 * a caller can opt a single request out of / into a different temperature. Only
 * an absent `input.temperature` is filled in with the wrapped value.
 *
 * Pure pass-through for every other field: `model` / `provider` / `surfaceId` /
 * `transportId` / `authMode` / `contextWindowKey` are delegated verbatim to
 * `inner`, and the event stream is forwarded unchanged.
 */
export const withTemperature = (inner: LLMPort, temperature: number): LLMPort => ({
  // Delegate the descriptive surface verbatim — the decorator changes only the
  // sampling temperature, never the identity of the underlying port.
  ...(inner.model !== undefined ? { model: inner.model } : {}),
  ...(inner.contextWindowKey !== undefined ? { contextWindowKey: inner.contextWindowKey } : {}),
  ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
  ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
  ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
  ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // Caller-set temperature wins (per-call override > per-port default);
    // otherwise inject the wrapped value. No other field is mutated.
    const next: StreamInput = input.temperature !== undefined ? input : { ...input, temperature }
    return inner.stream(next)
  },
})
