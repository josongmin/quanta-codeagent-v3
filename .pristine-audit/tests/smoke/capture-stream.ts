import type { AgentEvent, StreamPort } from "@/stream"

/**
 * Buffers every {@link AgentEvent} emitted during a smoke run so the
 * assertion layer can inspect tool calls, ordering, usage, and final text
 * without rummaging through CLI output. The exact same shape the loop emits
 * to a `StdoutStream` flows through here — capture is lossless.
 */
export class CaptureStream implements StreamPort {
  readonly events: AgentEvent[] = []
  /** Event-array offsets where each user-message run begins. The runner calls
   *  {@link beginRun} before each `runAgent` invocation so per-run slicing is
   *  exact rather than inferred from `turn_start` numbering. */
  private readonly runBoundaries: number[] = []

  emit(event: AgentEvent): void {
    this.events.push(event)
  }

  /** Mark the start of a new user-message run (called by the runner). */
  beginRun(): void {
    this.runBoundaries.push(this.events.length)
  }

  /** Tool-call names in the exact order they were emitted (one entry per
   *  `tool_call` event). */
  toolCallOrder(): string[] {
    const out: string[] = []
    for (const ev of this.events) {
      if (ev.type === "tool_call") out.push(ev.name)
    }
    return out
  }

  /** Per-tool call counts (`{read: 2, edit: 1, ...}`). */
  toolCallCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const name of this.toolCallOrder()) {
      counts[name] = (counts[name] ?? 0) + 1
    }
    return counts
  }

  /** Concatenate every `assistant_text` delta — the cumulative model response
   *  text the user would have seen. */
  assistantText(): string {
    let out = ""
    for (const ev of this.events) {
      if (ev.type === "assistant_text") out += ev.delta
    }
    return out
  }

  /** Per-run assistant text, sliced at the explicit {@link beginRun}
   *  boundaries. Index = which user message (0-indexed). Used by
   *  `contextRetention` assertions. */
  assistantTextByRun(): string[] {
    const bounds = this.runBoundaries.length > 0 ? this.runBoundaries : [0]
    return bounds.map((start, idx) => {
      const end = bounds[idx + 1] ?? this.events.length
      let text = ""
      for (let i = start; i < end; i++) {
        const ev = this.events[i]
        if (ev !== undefined && ev.type === "assistant_text") text += ev.delta
      }
      return text
    })
  }

  /** Last `usage` event's totals (Phase 1: latest-only; Phase 2 may sum). */
  lastUsage(): { inputTokens: number; outputTokens: number } | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]
      if (ev !== undefined && ev.type === "usage") {
        return { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens }
      }
    }
    return undefined
  }

  /** Every `error` event message in order — used by the runner to surface the
   *  agent-loop error detail when `outcome.reason === "error"` (Audit A R8 / C
   *  low). Empty array when the run had no error events. */
  errorMessages(): string[] {
    const out: string[] = []
    for (const ev of this.events) {
      if (ev.type === "error") out.push(ev.message)
    }
    return out
  }

  /** Sum of input + output tokens across ALL `usage` events. */
  totalUsage(): { inputTokens: number; outputTokens: number } {
    let inp = 0
    let out = 0
    for (const ev of this.events) {
      if (ev.type === "usage") {
        inp += ev.inputTokens
        out += ev.outputTokens
      }
    }
    return { inputTokens: inp, outputTokens: out }
  }
}
