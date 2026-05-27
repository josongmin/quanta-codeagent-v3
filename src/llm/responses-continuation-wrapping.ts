import type { LLMPort } from "./ports"
import type { ResponsesContinuationStore } from "./responses-continuation-store"
import type { StreamEvent, StreamInput } from "./types"

export interface ResponsesContinuationWrappingOpts {
  readonly inner: LLMPort
  readonly store: ResponsesContinuationStore
}

export const responsesContinuationLlmPort = (
  opts: ResponsesContinuationWrappingOpts,
): LLMPort => ({
  ...(opts.inner.model !== undefined ? { model: opts.inner.model } : {}),
  ...(opts.inner.provider !== undefined ? { provider: opts.inner.provider } : {}),
  ...(opts.inner.surfaceId !== undefined ? { surfaceId: opts.inner.surfaceId } : {}),
  ...(opts.inner.transportId !== undefined ? { transportId: opts.inner.transportId } : {}),
  ...(opts.inner.authMode !== undefined ? { authMode: opts.inner.authMode } : {}),
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    return opts.inner.stream(
      input.responsesContinuation !== undefined
        ? input
        : { ...input, responsesContinuation: { store: opts.store } },
    )
  },
})
