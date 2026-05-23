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
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure
  // signal. Emitted when the loop encountered a control-op or follow-up
  // dequeue request and DEFERRED it because the thread is paused or the
  // submission/action is not yet ready. Mirrors Codex's
  // `response.queued` event variant. Closed `reason` enum (additive). A
  // surface paints "queued — waiting on user approval" / "queued — rate
  // limited" without re-classifying error/recovery emits. NullStream
  // swallows it (default-OFF byte-identical). Adding a new reason MUST
  // extend `RESPONSE_QUEUED_REASONS` in `@/agent/follow-up-queue` or the
  // matching control-op handler — never inline a literal.
  | {
      type: "response_queued"
      /** Closed reason: matches the {@link PausedReason} taxonomy from
       *  `@/agent/follow-up-queue` extended with the two control-op-
       *  pending reasons documented in the handler. The value is a
       *  string-literal-union encoded as a plain string here to avoid an
       *  import cycle (stream → agent); the agent layer asserts the
       *  literal at the emit site. */
      reason: string
      /** Optional human hint (analytics / UI). Never used for control flow. */
      hint?: string
    }
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): submission /
  // conversation-action interrupt observed. Fired BEFORE the loop unwinds
  // to its `aborted` finish path so a surface knows "the abort came from
  // a typed control-op, not a raw signal trip". Closed `source` enum.
  | {
      type: "interrupted"
      source: "submission_interrupt" | "conversation_action_cancel"
      /** Optional human reason (verbatim from `cancel.reason` when the
       *  source is `conversation_action_cancel`). */
      reason?: string
    }
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): a typed
  // cancel_subagent op was routed to the subagent registry. `outcome`
  // mirrors `TaskRegistry.forceStop` return values plus an
  // `unknown_subagent` for the case where the registry has no record of
  // the id. The parent turn KEEPS running — this is observation only, not
  // a finish trigger.
  | {
      type: "subagent_cancel"
      subagentId: string
      outcome: "stopped" | "not_found" | "registry_absent"
      source: "submission_op" | "conversation_action"
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
