/**
 * ONE forwarder for an {@link LLMPort}'s non-stream surface (aug-27).
 *
 * Every port DECORATOR (temperature, usage, empty-stream breaker, progress
 * trace, image-sanitize retry, failed-attempt breaker, recording/eval lanes, the
 * CLI's spinner-stall wire) rebuilds a port object around `inner` and has to
 * re-forward the descriptive/capability fields. That copy was spelled inline in
 * each of them, which made a NEW port field default to being DROPPED by every
 * decorator: `listModels` (the `/model` catalog probe) shipped and was
 * immediately eaten by the CLI's spinner-stall wrapper — the interactive surface
 * saw a port with no probe and `/model` could only ever list the boot model.
 * Three of the inline copies had also silently dropped `contextWindowKey`, so a
 * granted 1M-token window resolved as 200k for compaction whenever one of those
 * decorators sat in the chain.
 *
 * Routing every decorator through this helper makes "forward the whole identity"
 * the default and adding a field a ONE-line change here.
 *
 * `listModels` is re-exposed as a CLOSURE over `inner` (never a bare method
 * reference): the real adapters implement it as a class method that reads
 * `this`, so copying the function value would unbind it.
 */

import type { LLMPort } from "./ports"

/** Copy every non-`stream` field of `inner` onto a decorator's port, omitting
 *  the absent ones (`exactOptionalPropertyTypes`-honest: an absent field stays
 *  ABSENT rather than becoming a literal `undefined`). */
export const forwardPortIdentity = (inner: LLMPort): Omit<LLMPort, "stream"> => {
  const list = inner.listModels
  return {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.contextWindowKey !== undefined ? { contextWindowKey: inner.contextWindowKey } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
    ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    // `.call(inner)` — see the header: the adapters' `listModels` is a class
    // method reading `this`, so the receiver must be re-bound, not copied.
    ...(list !== undefined ? { listModels: async () => await list.call(inner) } : {}),
  }
}
