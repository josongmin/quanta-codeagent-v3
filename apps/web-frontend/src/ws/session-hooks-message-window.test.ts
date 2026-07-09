/**
 * WS-F store hygiene (UUX-5-25) — the transcript messages[] must be bounded.
 *
 * Every append path funnels through the reducer's single append helper, so a
 * window cap there bounds the whole transcript: an hour-long session with
 * thousands of tool lines cannot grow memory (and reconcile cost) forever.
 * Backstop semantics mirror EVENT_DEDUP_CAP: far above any realistic visible
 * window, oldest-first eviction, newest always retained.
 */

import { describe, expect, it } from "vitest"
import {
  initialTranscript,
  MESSAGES_WINDOW_CAP,
  type TranscriptState,
  transcriptReducer,
} from "./session-hooks"

const appendN = (state: TranscriptState, n: number, offset = 0): TranscriptState => {
  let next = state
  for (let i = 0; i < n; i += 1) {
    next = transcriptReducer(next, {
      type: "client_message",
      role: "system",
      text: `msg-${offset + i}`,
      timestamp: `t-${offset + i}`,
    })
  }
  return next
}

describe("transcript messages window cap (UUX-5-25)", () => {
  it("declares a finite backstop cap", () => {
    expect(MESSAGES_WINDOW_CAP).toBeGreaterThanOrEqual(200)
    expect(MESSAGES_WINDOW_CAP).toBeLessThanOrEqual(5_000)
  })

  it("appending past the cap keeps the NEWEST cap-many messages", () => {
    const state = appendN(initialTranscript, MESSAGES_WINDOW_CAP + 50)
    expect(state.messages.length).toBe(MESSAGES_WINDOW_CAP)
    // Oldest 50 evicted; newest retained.
    expect(state.messages[0]?.text).toBe("msg-50")
    expect(state.messages.at(-1)?.text).toBe(`msg-${MESSAGES_WINDOW_CAP + 50 - 1}`)
  })

  it("under the cap nothing is evicted", () => {
    const state = appendN(initialTranscript, 10)
    expect(state.messages.length).toBe(10)
    expect(state.messages[0]?.text).toBe("msg-0")
  })
})
