import { forwardPortIdentity } from "./port-identity"
import type { LLMPort } from "./ports"
import type { ResponsesContinuationStore } from "./responses-continuation-store"
import type { StreamEvent, StreamInput } from "./types"

export interface ResponsesContinuationWrappingOpts {
  readonly inner: LLMPort
  readonly store: ResponsesContinuationStore
}

export const responsesContinuationLlmPort = (opts: ResponsesContinuationWrappingOpts): LLMPort => ({
  // aug-28 — ONE forwarder (see `./port-identity`). The inline copy this replaces
  // dropped `contextWindowKey` AND `listModels`, and this wrapper is the OUTERMOST
  // one on the interactive CLI's `config.llm`: so a granted 1M-token window
  // resolved as 200k for compaction on the primary surface, and the `/model`
  // catalog probe was invisible to the loop's port. Both were exactly the defects
  // the campaign that added the helper set out to close.
  ...forwardPortIdentity(opts.inner),
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    return opts.inner.stream(
      input.responsesContinuation !== undefined
        ? input
        : { ...input, responsesContinuation: { store: opts.store } },
    )
  },
})
