/** Deterministic raw Anthropic-message stream for provider cancellation rails.
 * It keeps explicit iterator finalization hooks so tests prove a consumer break
 * closes the upstream source instead of merely ceasing to observe output. */

export type RawMessageSpyHooks = {
  readonly onDelta?: () => void
  readonly onReturn: () => void
  readonly onThrow?: () => void
}

const rawMessageEvent = (index: number): unknown | undefined => {
  if (index === 0) {
    return { type: "message_start", message: { model: "x", usage: { input_tokens: 1 } } }
  }
  if (index === 1) {
    return { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  }
  return index < 1000
    ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }
    : undefined
}

export const makeRawMessageSpyStream = (hooks: RawMessageSpyHooks): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    let index = 0
    let done = false
    return {
      async next() {
        if (done) return { value: undefined, done: true }
        const value = rawMessageEvent(index)
        if (value === undefined) {
          done = true
          return { value: undefined, done: true }
        }
        if (index >= 2) hooks.onDelta?.()
        index += 1
        return { value, done: false }
      },
      async return(value?: unknown) {
        hooks.onReturn()
        done = true
        return { value, done: true }
      },
      async throw(error?: unknown) {
        hooks.onThrow?.()
        done = true
        throw error
      },
    }
  },
})
