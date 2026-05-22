export type AgentEvent =
  // RFC-0002 §5.2 `session_start` — emitted once at run start so the trajectory
  // has a head marker (recorder maps it to kind:"session_start").
  | { type: "session_start" }
  | { type: "turn_start"; turn: number }
  // RFC-0002 §5.2/§9 `llm_request` — emitted immediately BEFORE the model
  // stream so the recorder can pair it (same span) with the trailing
  // `llm_usage`, completing the §11 llm_request↔llm_usage span-pair golden.
  | { type: "llm_request"; model: string }
  | { type: "assistant_text"; delta: string }
  // ADR-0048 in-progress heartbeat — surfaced from a provider's
  // `response.in_progress` event so a UI can paint a "thinking…" indicator.
  // Mirrors the `InProgressIndicator` the streaming engine produces: a stable
  // receive-side `timestamp` plus the optional provider-supplied `message` /
  // `progress`. Emitted ONLY when the loop wires `onInProgress` (which it now
  // does unconditionally — but the provider must actually yield the event AND
  // the configured stream must be non-null for it to surface). NullStream
  // swallows it, so the default-OFF byte-identical contract holds.
  | { type: "in_progress"; timestamp: number; message?: string; progress?: number }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_progress"; id: string; name: string; message: string }
  // RFC-0002 §5.2 `tool_result` data contract: `preview` is the stdout tail;
  // the optional fields carry the rest of the mandated evidence (durationMs,
  // stderrTail, exitCode, fullLogPath) when the tool produced them.
  | {
      type: "tool_result"
      id: string
      name: string
      ok: boolean
      preview: string
      durationMs?: number
      stderrTail?: string
      exitCode?: number
      fullLogPath?: string
    }
  // RFC-0002 §5.2 `recovery` — backoff/compact/nudge/empty/malformed traces.
  | { type: "recovery"; reason: string; detail?: string }
  // ADR-0075: Cursor-style proactive-compaction marker. Emitted ALONGSIDE the
  // existing `recovery:{reason:"compact"}` event (so legacy consumers stay
  // working byte-identically — the recovery emit precedes this one in the
  // same call site) when `compaction.archive:true` is configured. Carries the
  // archive entry payload (fromTurnId..toTurnId + summary + ts + tokens) so a
  // session jsonl recorder / UI can render the compaction history without
  // re-parsing the synthetic `<conversation summary>` user message.
  | {
      type: "context_compacted"
      fromTurnId: string
      toTurnId: string
      summary: string
      ts: number
      tokens: number
    }
  | { type: "error"; message: string }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      model: string
    }
  | { type: "done"; reason: string; turns: number }

/**
 * Retention policy for jsonl recorder files (ADR-0035). Public surface in the
 * stream slice so callers in `@/agent` can declare a single policy object and
 * pass it both to a scheduled retention job and to dashboards that inspect
 * the same threshold. No defaults — caller MUST provide.
 */
export interface RetentionPolicy {
  /** Cumulative-bytes sliding window. Must be a finite positive number. */
  maxCumulativeBytes: number
  /**
   * If set, the recommended cadence at which a wiring layer should call
   * `applyRetention`. The retention function itself is one-shot — it never
   * polls. This field is metadata for the caller's scheduler.
   */
  intervalMs?: number
}
