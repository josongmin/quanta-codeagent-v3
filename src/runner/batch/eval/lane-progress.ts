/**
 * Parallel-lane PROGRESS bus (D-lite event bus).
 *
 * The bench runs N candidates (repair-breadth, verify-select) CONCURRENTLY. This
 * bus decouples "what a lane is doing right now" (emitted at the fork sites) from
 * "how it is shown" (a CLI renderer, the trajectory viewer, a future web
 * surface). Emit is a NO-OP when nothing is subscribed, so the fork-site calls
 * stay byte-identical for non-interactive / library hosts.
 *
 * Runner-owned (not apps) so the fork sites in `src/runner/batch/eval/**` can
 * emit without importing an app; the CLI renderer in `src/apps/bench` subscribes.
 */
import type { LLMPort } from "@/llm"
import type { StreamEvent, StreamInput } from "@/llm/types"

export interface LaneProgressEvent {
  /** start = candidate spawned; turn = a new LLM round began; tool = a tool call
   *  started this turn; done = candidate finished (with outcome). */
  readonly kind: "start" | "turn" | "tool" | "done"
  /** Lane correlation id — same string as the recording lane (repair-breadth#N,
   *  verify-select#N). */
  readonly lane: string
  /** 1-based turn counter (turn/tool events). */
  readonly turn?: number
  /** Tool name (tool events). */
  readonly tool?: string
  /** Candidate resolved a passing patch (done events). */
  readonly ok?: boolean
  /** Final patch size in bytes (done events). */
  readonly patchBytes?: number
}

type Listener = (e: LaneProgressEvent) => void

class LaneProgressBus {
  private readonly listeners = new Set<Listener>()

  /** Subscribe a renderer; returns an unsubscribe handle. */
  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  /** True iff at least one renderer is listening (lets emitters skip work). */
  get active(): boolean {
    return this.listeners.size > 0
  }

  /** Fan out an event. A throwing listener never breaks the run or the siblings. */
  emit(e: LaneProgressEvent): void {
    if (this.listeners.size === 0) return
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        // a renderer bug must never sink a candidate.
      }
    }
  }
}

/** Process-scoped singleton bus. */
export const laneProgress = new LaneProgressBus()

/**
 * SOLID decorator: wrap a lane's {@link LLMPort} so it emits progress —
 * a `turn` event on each `stream()` (one LLM round) and a `tool` event on each
 * `tool_use_start`. Pure pass-through otherwise: events flow to the caller
 * unchanged, no field is mutated. Composes over {@link laneLabeledPort}
 * (recording) — this one is for LIVE display only. Inert when the bus has no
 * subscriber (emit short-circuits).
 */
export const laneProgressPort = (inner: LLMPort, lane: string): LLMPort => {
  let turn = 0
  return {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.contextWindowKey !== undefined ? { contextWindowKey: inner.contextWindowKey } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
    ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      turn += 1
      const n = turn
      laneProgress.emit({ kind: "turn", lane, turn: n })
      const it = inner.stream(input)
      async function* gen(): AsyncIterable<StreamEvent> {
        for await (const ev of it) {
          if (ev.type === "tool_use_start") {
            laneProgress.emit({ kind: "tool", lane, turn: n, tool: ev.name })
          }
          yield ev
        }
      }
      return gen()
    },
  }
}
