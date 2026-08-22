import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { TrajectoryEntry } from "./types"

/**
 * Deterministic `LLMPort` that replays a recorded trajectory keyed by
 * `(run, turn)`. Used by the tier-0 smoke runner to drive `runAgent` without
 * touching a real provider.
 *
 *   - `run`  index = which user message (0-indexed). Caller advances it
 *            BETWEEN `runAgent` invocations via {@link nextRun}.
 *   - `turn` index = which LLM call within the current run (0-indexed).
 *            Advances automatically each time `stream()` is invoked.
 *
 * Exhausting the trajectory mid-run throws — a stale fixture must FAIL loud,
 * not silently truncate, so the operator goes and re-records.
 */
export class TrajectoryReplayLLM implements LLMPort {
  readonly model = "replay"
  /** Inputs captured per stream call — useful for invariants (e.g. system
   *  prompt stability across compaction). */
  readonly inputs: StreamInput[] = []
  private readonly byRunTurn: Map<string, StreamEvent[]>
  /** Set of `(run,turn)` keys that have actually been streamed. Used to detect
   *  UNDER-consumption: if the agent diverges to FEWER turns than recorded,
   *  recorded buckets are left unused and the run would otherwise pass silently
   *  (FLAG 2). Symmetric to the exhaustion throw (over-consumption). */
  private readonly consumed = new Set<string>()
  private readonly scenarioHint: string
  private run = 0
  private turn = 0

  constructor(entries: readonly TrajectoryEntry[], scenarioHint = "<unknown>") {
    this.scenarioHint = scenarioHint
    const buckets = new Map<string, StreamEvent[]>()
    for (const e of entries) {
      const key = `${e.run}:${e.turn}`
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = []
        buckets.set(key, bucket)
      }
      bucket.push(e.event as StreamEvent)
    }
    this.byRunTurn = buckets
  }

  /** Recorded `(run,turn)` buckets that were never streamed. Empty ⇒ the agent
   *  consumed the whole trajectory. A non-empty result after a run means the
   *  agent diverged to FEWER turns than recorded (re-record or fix the agent).
   *  Content fingerprinting (asserting the agent fed back the SAME inputs that
   *  produced each recorded turn) is an intentional FOLLOW-UP — out of scope for
   *  this low-risk hardening pass. */
  remaining(): string[] {
    const left: string[] = []
    for (const key of this.byRunTurn.keys()) {
      if (!this.consumed.has(key)) left.push(key)
    }
    return left.sort()
  }

  /** True when every recorded bucket was streamed. */
  consumedAll(): boolean {
    return this.remaining().length === 0
  }

  /** Advance to the next user-message bucket. Called by the runner after each
   *  `runAgent` returns and BEFORE feeding the next prompt. */
  nextRun(): void {
    this.run += 1
    this.turn = 0
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const key = `${this.run}:${this.turn}`
    const bucket = this.byRunTurn.get(key)
    if (bucket === undefined) {
      throw new Error(
        `smoke trajectory exhausted at run=${this.run} turn=${this.turn} ` +
          `for scenario "${this.scenarioHint}" ` +
          `(no events recorded for this bucket — re-record the fixture)`,
      )
    }
    this.consumed.add(key)
    this.turn += 1
    for (const ev of bucket) yield ev
  }
}
