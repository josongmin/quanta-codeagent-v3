/**
 * Voice transcript queue (ADR-0202).
 *
 * SINGLE-SHOT confirm-required queue holding the most-recent voice
 * transcript awaiting user submission. The prompt pipeline checks this
 * queue on every input line; the transcript is promoted to the prompt
 * text ONLY when the user types an empty line (i.e. presses Enter on
 * an empty composer). Any other input clears the queue silently — voice
 * NEVER auto-submits, and a stale transcript NEVER survives a typed-over
 * turn.
 *
 * The queue is mirror-shaped to `ImageQueue` (single drain per turn) so
 * the pipeline composition pattern stays uniform across input channels.
 */

export interface VoiceTranscriptEntry {
  readonly text: string
  readonly confidence: number
  readonly languageHint?: string
}

export interface VoiceTranscriptQueue {
  /** Replace any pending transcript with `entry`. Voice round-trips are
   *  one-at-a-time per the safe invariant, so a second push silently
   *  evicts the first. */
  set(entry: VoiceTranscriptEntry): void
  /** Peek without consuming — used by the pipeline overlay to render the
   *  "press Enter to send" banner before reading the line. */
  peek(): VoiceTranscriptEntry | undefined
  /** Atomically return + clear. The pipeline calls this exactly once per
   *  promoted-to-prompt turn. */
  drain(): VoiceTranscriptEntry | undefined
  /** Discard the pending transcript without returning. Called by the
   *  pipeline whenever the user types non-empty input over the banner. */
  clear(): void
  size(): 0 | 1
}

export const createVoiceTranscriptQueue = (): VoiceTranscriptQueue => {
  let slot: VoiceTranscriptEntry | undefined
  return {
    set(entry) {
      slot = entry
    },
    peek() {
      return slot
    },
    drain() {
      const out = slot
      slot = undefined
      return out
    },
    clear() {
      slot = undefined
    },
    size() {
      return slot === undefined ? 0 : 1
    },
  }
}
