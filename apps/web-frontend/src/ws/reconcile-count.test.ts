/**
 * RECONCILE-COUNT PROOF — the acute streaming perf bottleneck.
 *
 * BEFORE the fix, every `turn.output.delta` token rebuilt the WHOLE `messages`
 * array (`[...slice(0,-1), {...last, text}]`) and returned a NEW `messages`
 * reference. That popped `TranscriptViewport`'s `prev.messages === next.messages`
 * memo gate, so the ENTIRE transcript re-mapped N `MessageBubble`s and ran N
 * per-bubble comparators EVERY token — O(M·T) alloc + O(N)/token reconcile.
 *
 * The FIX holds the in-progress streaming text ONLY in the `streamingAssistant`
 * slot and does NOT mirror it into `messages` during streaming. Result: while
 * streaming, the `messages` array REFERENCE is STABLE ⇒ the viewport memo bails
 * ⇒ zero per-token transcript reconcile.
 *
 * The env is `node` (no jsdom / testing-library — see vite.config.ts). We prove
 * the win at the reducer + memo-predicate boundary, which is exactly what React
 * would evaluate:
 *   1. Drive the transcript reducer with N=200 seeded finalized messages, then
 *      fire K=50 deltas. Assert the `messages` reference is IDENTICAL across all
 *      K deltas (the memo's `prev.messages === next.messages` short-circuits).
 *   2. For each delta, build the viewport props from the reducer output and call
 *      the exported `areTranscriptViewportPropsEqual`. It must return `true`
 *      (bail) EVERY delta — which is what tells React to skip the whole subtree.
 *   3. Instrument `areMessageBubblePropsEqual`: because the viewport bails, React
 *      never descends into the list, so the per-bubble comparator runs 0 times
 *      during streaming — independent of K and of N.
 */
import { describe, expect, it, vi } from "vitest"
import { areTranscriptViewportPropsEqual } from "../components/ChatPanel"
import * as MessageBubbleModule from "../components/MessageBubble"
import type { SessionEvent, UiMessage } from "../types/protocol"
import {
  applySessionEventToTranscript,
  initialTranscript,
  type TranscriptState,
} from "./session-hooks"

const N = 200
const K = 50

const seededTranscript = (n: number): TranscriptState => {
  const messages: UiMessage[] = []
  for (let i = 0; i < n; i += 1) {
    messages.push({
      id: `seed-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `finalized message ${i}`,
      timestamp: "2026-05-26T13:00:00.000Z",
    })
  }
  return { ...initialTranscript, messages }
}

const deltaEvent = (delta: string, seq: number): SessionEvent =>
  ({
    eventId: `delta-${seq}`,
    seq,
    revision: 1,
    emittedAt: "2026-05-26T13:00:02.000Z",
    causedByCommandId: "cmd-run-1",
    type: "turn.output.delta",
    delta,
  }) as Extract<SessionEvent, { type: "turn.output.delta" }>

interface ViewportProps {
  readonly messages: readonly UiMessage[]
}

// The transcript list is memo'd ONLY on the `messages` reference — the live
// streaming text lives outside it (in the `streamingAssistant` slot, rendered
// as a sibling tail), so neither `streamingMessageId` nor `sessionStatus` needs
// to invalidate the finalized list.
const viewportPropsOf = (state: TranscriptState): ViewportProps => ({
  messages: state.messages,
})

describe("streaming reconcile-count (perf proof)", () => {
  it("keeps the messages ref STABLE across every streaming delta (memo bails ⇒ zero transcript reconcile)", () => {
    let state = seededTranscript(N)
    const finalizedMessagesRef = state.messages
    expect(state.messages).toHaveLength(N)

    let prevProps = viewportPropsOf(state)
    let viewportBailCount = 0

    for (let k = 0; k < K; k += 1) {
      state = applySessionEventToTranscript(state, deltaEvent(`tok${k} `, k + 1))
      const nextProps = viewportPropsOf(state)

      // The memo predicate React would run for the transcript viewport. `true`
      // means "props equal ⇒ SKIP the whole subtree" (the bail we want).
      if (areTranscriptViewportPropsEqual(prevProps, nextProps)) viewportBailCount += 1
      prevProps = nextProps
    }

    // The finalized transcript array must be the SAME reference it started as —
    // no per-token rebuild of the N-message list.
    expect(state.messages).toBe(finalizedMessagesRef)
    expect(state.messages).toHaveLength(N)

    // The viewport memo bailed on EVERY one of the K streaming deltas.
    expect(viewportBailCount).toBe(K)

    // The live text lives in the streaming slot, not the messages array.
    expect(state.streamingAssistant?.text).toBe(
      Array.from({ length: K }, (_, k) => `tok${k} `).join(""),
    )
  })

  it("runs the per-bubble comparator ZERO times during streaming (subtree skipped, independent of K and N)", () => {
    // Simulate React's reconcile: it consults the viewport memo FIRST; only if
    // that returns `false` (props changed) does it descend and run the N
    // per-bubble `areMessageBubblePropsEqual` comparators. We count real calls.
    const spy = vi.spyOn(MessageBubbleModule, "areMessageBubblePropsEqual")

    let state = seededTranscript(N)
    let prevProps = viewportPropsOf(state)

    const simulateReactReconcileBubbles = (
      prevMessages: readonly UiMessage[],
      nextMessages: readonly UiMessage[],
    ): void => {
      const len = Math.max(prevMessages.length, nextMessages.length)
      for (let i = 0; i < len; i += 1) {
        const p = prevMessages[i]
        const nx = nextMessages[i]
        if (p === undefined || nx === undefined) continue
        MessageBubbleModule.areMessageBubblePropsEqual({ message: p }, { message: nx })
      }
    }

    for (let k = 0; k < K; k += 1) {
      const before = state.messages
      state = applySessionEventToTranscript(state, deltaEvent(`tok${k} `, k + 1))
      const nextProps = viewportPropsOf(state)
      // React only descends into the list when the viewport memo does NOT bail.
      if (!areTranscriptViewportPropsEqual(prevProps, nextProps)) {
        simulateReactReconcileBubbles(before, state.messages)
      }
      prevProps = nextProps
    }

    // Zero per-bubble comparisons during streaming — the whole list was skipped
    // every token. Independent of K (50) and N (200).
    expect(spy).toHaveBeenCalledTimes(0)
    spy.mockRestore()
  })
})
