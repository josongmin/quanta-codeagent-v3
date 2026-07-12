import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Producer, RunContext, TrajectoryKind } from "@/shared"
import { assertNever, errMessage, logger, makeEvent, toError } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"
import type { DegradedRecord } from "./tee"

export interface JsonlRecorderOpts {
  ctx?: RunContext
  /** eval/strict mode: serialize/write failure rethrows. Default `false`. */
  strict?: boolean
  /** Wall-clock epoch ms (inject for determinism). Default `Date.now`. */
  now?: () => number
  /** Monotonic clock ns for latency math (inject for determinism). */
  monotonic?: () => number
  /**
   * DI seam for the active OTel trace context (C3/C7). Returns the ids of the
   * span currently open in the loop (established by C1's context layer), or
   * `undefined` when no context is active. Deliberately a PLAIN structural type
   * — `@/stream` may NOT import `@/observability` (slice boundary, guarded by
   * tests/unit/stream-slice-boundary.test.ts), so the ref shape is mirrored here.
   *
   * Compat window (C3): when this returns a ref, its ids OVERRIDE the
   * deterministic `spanOf()` scheme on the emitted event; when it returns
   * `undefined` (or the callback is absent), the recorder falls back to the
   * deterministic `t<turn>` / `llm:t<turn>` / `tool:<id>` ids. Absent callback ⇒
   * byte-identical output to today. Full no-fallback is C7.
   */
  getActiveTraceRef?: () => { traceId: string; spanId: string; parentSpanId?: string } | undefined
  /** Hard line cap; once exceeded only a final `line_cap` degraded line is
   *  written. Default 100000. */
  maxLines?: number
  producer?: Producer
}

const DEFAULT_MAX_LINES = 100_000
const FLUSH_BATCH = 16
const EMPTY_CTX: RunContext = { runId: "unknown" }

/**
 * Crash-resilience registry (F2). On a hard box death (OOM / exit137 / SIGKILL
 * / spot-reclaim SIGTERM) the `finally` that calls `close()` never runs, so the
 * last ≤`FLUSH_BATCH-1` buffered events — the turns that explain the crash —
 * would be lost. Spot reclaim in particular sends SIGTERM with a ~2min warning,
 * so a best-effort flush on that signal saves the tail. We hold live recorders
 * in a module-scoped set and flush them all when the signal fires.
 *
 * SIGKILL/exit137 can't be trapped in-process; the turn-boundary flush in
 * `emit` (below) is what protects the tail there — each completed turn is on
 * disk before the next one starts.
 */
const liveRecorders = new Set<JsonlRecorder>()
let signalHandlerInstalled = false

/** Register the SIGTERM/SIGINT best-effort flush ONCE. Never throws — a broken
 *  flush on one recorder must not stop the others or the process teardown. */
function ensureSignalFlush(): void {
  if (signalHandlerInstalled) return
  signalHandlerInstalled = true
  const flushAll = (): void => {
    for (const rec of liveRecorders) {
      try {
        rec.flush()
      } catch {
        // Best-effort: a torn-down volume must not abort the teardown path or
        // block the remaining recorders. The tail we could save, we saved.
      }
    }
  }
  // Do not consume the signal (no re-emit / process.exit): we only piggy-back a
  // flush; the runtime's default disposition (and any user handler) still runs.
  try {
    process.on("SIGTERM", flushAll)
    process.on("SIGINT", flushAll)
  } catch {
    // Some sandboxes forbid signal registration — degrade to turn-boundary
    // flush only rather than crash the recorder at construction time.
  }
}

interface PendingChunk {
  readonly body: string
  readonly lineCount: number
}

/**
 * Span-correlation scheme (deterministic — golden-testable, no randomness):
 *
 *  - `turn_start` opens a new turn span `t<turn>` (falls back to `t#<seq>` if
 *    the AgentEvent carries no turn). Every later event in that turn carries
 *    `parentSpanId = turnSpanId`.
 *  - `tool_call` / `tool_progress` / `tool_result` sharing a tool-use `id`
 *    all get `spanId = "tool:" + id` with `parentSpanId = turnSpanId`.
 *  - `llm_request` AND `usage` (llm) BOTH get `spanId = "llm:" + turnSpanId`,
 *    `parentSpanId = turnSpanId` — one request→one usage per turn, so the
 *    `llm_request↔llm_usage` span pair (RFC-0002 §5.2/§9/§11) is exact and
 *    deterministic (`request.spanId === usage.spanId`).
 *  - `turn_start` itself is the span root: `spanId = turnSpanId`, no parent.
 *
 * Given an identical event sequence the scheme reproduces byte-identical
 * spans across runs.
 *
 * `costUsd` is always `null` here: the recorder lives in `@/stream` and slice
 * isolation (RFC §6, biome.json) forbids importing `@/observability/pricing`.
 * Cost is derived later by probe/bench, which may import the versioned price
 * table — keeping the trajectory recomputable when prices drift (RFC §5.3).
 */
export class JsonlRecorder implements StreamPort {
  private readonly ctx: RunContext
  private readonly strict: boolean
  private readonly now: () => number
  private readonly monotonic: (() => number) | undefined
  private readonly getActiveTraceRef:
    | (() => { traceId: string; spanId: string; parentSpanId?: string } | undefined)
    | undefined
  private readonly maxLines: number
  private readonly producer: Producer | undefined
  private readonly buf: string[] = []
  private readonly pending: PendingChunk[] = []
  private seq = 0
  private written = 0
  private turnSpanId = "t#init"
  private closed = false
  private capDone = false
  private dropped = 0
  private pendingHead = 0
  private pendingLineCount = 0

  constructor(
    private readonly target: string,
    opts: JsonlRecorderOpts = {},
  ) {
    this.ctx = opts.ctx ?? EMPTY_CTX
    this.strict = opts.strict ?? false
    this.now = opts.now ?? (() => Date.now())
    this.monotonic = opts.monotonic
    this.getActiveTraceRef = opts.getActiveTraceRef
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
    this.producer = opts.producer
    mkdirSync(dirname(target), { recursive: true })
    // F2: enroll in the crash-flush registry so a spot-reclaim SIGTERM can save
    // this recorder's buffered tail. Idempotent handler install (registered once
    // process-wide). Removed in `close()` so a normally-closed recorder isn't
    // re-flushed (a no-op on an empty buffer, but keeps the set from leaking).
    ensureSignalFlush()
    liveRecorders.add(this)
  }

  emit(event: AgentEvent): void {
    if (event.type === "turn_start") this.turnSpanId = `t${event.turn}`
    // `output_progress` is a high-frequency, non-durable UI signal (the rising
    // "· N tokens" live counter). It is deliberately NOT persisted to the
    // trajectory — recording one line per streamed delta would bloat the jsonl
    // and add nothing a consumer needs (the terminal `usage` line carries the
    // authoritative count). Skipping here keeps it out of `KIND_MAP` / `dataOf`.
    if (event.type === "output_progress") return
    // jun-6 account-ratelimit-snapshot — the `ratelimit_snapshot` notice is the
    // SAME class of transient, NON-accounting UI signal as `output_progress` (a
    // quota meter for the spinner, never folded into the recorder/budget). Skip
    // it for the same reasons — it carries no durable trajectory value and must
    // stay out of `KIND_MAP` / `dataOf`.
    if (event.type === "ratelimit_snapshot") return
    // gap-other-agent GAP 10 — item lifecycle (item_started/updated/completed) is
    // the SAME class of transient, render-only UI signal as output_progress: it
    // carries no durable trajectory state, so the recorder SKIPS it (kept out of
    // `RecordedEventType` below so `KIND_MAP` / `dataOf` never see it).
    if (
      event.type === "item_started" ||
      event.type === "item_updated" ||
      event.type === "item_completed"
    )
      return
    // ADR-0512 — skill-scope decision is a transient render-only signal (see the
    // `RecordedEventType` exclusion); the out-of-scope outcome is already in the
    // tool_result / recovery trajectory (and the DURABLE escalation pair is
    // recorded separately below), so the recorder skips this summary line.
    if (event.type === "skill_scope_decision") return
    // jun-11 (#11) — `assistant_thinking` is a transient render-only reasoning
    // signal (DIM stream), the SAME class as item_* / output_progress: the
    // durable trajectory records the assistant's ANSWER (`assistant_text`) and
    // its actions, not the streamed reasoning summary. Kept out of
    // `RecordedEventType` below so KIND_MAP / dataOf never see it.
    if (event.type === "assistant_thinking") return
    // ALBB-21 — `budget_breach` is a transient, NON-accounting advisory (a
    // soft/hard cost-cap crossing banner), the SAME class as `ratelimit_snapshot`
    // / `output_progress`: it carries no durable trajectory value (the cost totals
    // ARE recorded via the `usage`/`llm_usage` line), so the recorder SKIPS it —
    // kept out of `RecordedEventType` below so KIND_MAP / dataOf never see it.
    if (event.type === "budget_breach") return
    if (this.written >= this.maxLines) {
      this.handleCap()
      return
    }
    this.record(kindOf(event), dataOf(event), spanOf(event, this.turnSpanId))
    // F2 turn-boundary flush: force the buffer to disk at the events that mark
    // a completed unit of work — a new turn opening (`turn_start`), the session
    // ending (`done`→session_end), or a failure (`error`). This guarantees each
    // finished turn is durable BEFORE the next one starts, so a hard crash
    // (OOM/exit137/SIGKILL — untrappable, so the signal handler can't help)
    // still leaves the explanatory tail on disk. Behavior-neutral vs the
    // batched path: same bytes, same order, just flushed earlier. Cheap — one
    // flush per turn, not per delta. Best-effort: a flush failure here is already
    // handled the same way as any other (degraded snapshot via close()/next flush).
    if (event.type === "turn_start" || event.type === "done" || event.type === "error") {
      try {
        this.flush()
      } catch (e) {
        // Route a boundary-flush failure through the SAME degrade path the
        // batched `flushMaybe` failure takes (via `record`): count the drop and,
        // in strict mode, rethrow — so this extra flush never changes the
        // non-strict/strict contract, only WHEN the write happens.
        this.degrade(toError(e), this.strict)
      }
    }
  }

  private record(
    kind: TrajectoryKind,
    data: Record<string, unknown>,
    span: { spanId?: string; parentSpanId?: string },
  ): void {
    try {
      const line = JSON.stringify(this.frame(kind, data, span))
      this.writeLine(line)
      this.flushMaybe()
    } catch (e) {
      this.degrade(toError(e), this.strict)
    }
  }

  private frame(
    kind: TrajectoryKind,
    data: Record<string, unknown>,
    span: { spanId?: string; parentSpanId?: string },
  ) {
    // C3 compat window: if a live OTel trace context is available, stamp its
    // ids (traceId/spanId/parentSpanId) ONTO the event — overriding the
    // deterministic `spanOf()` scheme. When no ref (callback absent OR returns
    // undefined), fall back to the deterministic ids so absent-callback output
    // stays byte-identical to today. Full no-fallback is C7.
    const ref = this.getActiveTraceRef?.()
    const ids = ref
      ? {
          traceId: ref.traceId,
          spanId: ref.spanId,
          ...(ref.parentSpanId !== undefined ? { parentSpanId: ref.parentSpanId } : {}),
        }
      : {
          ...(span.spanId !== undefined ? { spanId: span.spanId } : {}),
          ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
        }
    return makeEvent(this.seq++, kind, this.ctx, data, {
      ts: this.now(),
      ...(this.monotonic ? { monotonicNs: this.monotonic() } : {}),
      ...ids,
      ...(this.producer ? { producer: this.producer } : {}),
    })
  }

  private handleCap(): void {
    // L6 M6(b): every event past the cap is a real drop — count them all.
    // Only the degraded cap-line is emitted once (capDone guard below).
    this.dropped += 1
    if (this.capDone) return
    this.capDone = true
    try {
      const line = JSON.stringify(
        this.frame(
          "observability_degraded",
          { component: "JsonlRecorder", reason: "line_cap", droppedEvents: this.dropped },
          { spanId: this.turnSpanId },
        ),
      )
      this.writeLine(line)
      this.flush()
    } catch {
      // best-effort: the cap line itself is allowed to fail silently
    }
  }

  private degrade(err: Error, rethrow: boolean): void {
    this.dropped += 1
    if (rethrow) throw err
    this.tryDegradedLine(err.message)
  }

  private tryDegradedLine(reason: string): void {
    try {
      const line = JSON.stringify(
        this.frame(
          "observability_degraded",
          { component: "JsonlRecorder", reason, droppedEvents: this.dropped },
          { spanId: this.turnSpanId },
        ),
      )
      // Best-effort: bypass the (possibly broken) buffered path with a direct
      // append so the trace records that something was dropped.
      appendFileSync(this.target, `${line}\n`)
    } catch (e) {
      // R-Phase2 P1-3: never throw to the agent in non-strict mode, but ALSO
      // never silently lose the signal that observability itself is broken.
      // A failed degraded-line append usually means the target file is
      // unwritable (permissions / volume gone / filesystem full); emit a
      // single stderr line so an operator can see "trajectory is now blind".
      logger.warn("jsonl-recorder: degraded-line append failed", {
        reason,
        target: this.target,
        droppedEvents: this.dropped,
        error: errMessage(e),
      })
    }
  }

  /** Buffered append. Monkeypatch target in tests to force write failure. */
  private writeLine(line: string): void {
    this.buf.push(`${line}\n`)
    this.written += 1
  }

  private flushMaybe(): void {
    if (this.pendingLineCount + this.buf.length >= FLUSH_BATCH) this.flush()
  }

  private enqueueBufferedChunk(): void {
    if (this.buf.length === 0) return
    this.pending.push({ body: this.buf.join(""), lineCount: this.buf.length })
    this.pendingLineCount += this.buf.length
    this.buf.length = 0
  }

  private dropFlushedChunk(): void {
    const chunk = this.pending[this.pendingHead]
    if (chunk !== undefined) this.pendingLineCount -= chunk.lineCount
    this.pendingHead += 1
    if (this.pendingHead === this.pending.length) {
      this.pending.length = 0
      this.pendingHead = 0
      return
    }
    if (this.pendingHead >= 32 && this.pendingHead * 2 >= this.pending.length) {
      this.pending.splice(0, this.pendingHead)
      this.pendingHead = 0
    }
  }

  flush(): void {
    this.enqueueBufferedChunk()
    while (this.pendingHead < this.pending.length) {
      const chunk = this.pending[this.pendingHead]
      if (chunk === undefined) return
      // Materialize each buffered batch once, then retry the same chunk until
      // it lands. This keeps flush failures retryable without repeatedly
      // rejoining the entire pending buffer on every attempt.
      appendFileSync(this.target, chunk.body)
      this.dropFlushedChunk()
    }
  }

  /** Flush + close. Idempotent. Never throws to the caller: a failed final
   *  flush is downgraded to a best-effort degraded line so close() at the end
   *  of a run can't crash the agent (mirrors the non-strict emit contract). */
  close(): void {
    if (this.closed) return
    // F2: leave the crash-flush registry — a cleanly-closed recorder must not be
    // re-flushed by a later SIGTERM (harmless on an empty buffer, but keeps the
    // set from growing unbounded across many runs in one process). Done before
    // the flush so an in-flight signal handler racing close() can't double-flush
    // the same drained buffer.
    liveRecorders.delete(this)
    // L6 M6(a): flush BEFORE flipping `closed`. A flush failure must leave the
    // recorder re-closable so a later close() retries the pending buffer; if we
    // set the flag first, a transient disk error permanently traps the data.
    try {
      this.flush()
      this.closed = true
    } catch (e) {
      // strict mode still surfaces the failure; non-strict records a degraded
      // line and swallows so a torn-down volume can't fault the shutdown path.
      this.degrade(toError(e), this.strict)
    }
  }

  /** Snapshot of degraded state for the caller. */
  degraded(): DegradedRecord[] {
    if (this.dropped === 0) return []
    return [{ component: "JsonlRecorder", reason: "write_failure", count: this.dropped }]
  }
}

// `output_progress` is excluded: it is a transient UI signal that `emit`
// drops before reaching `kindOf`/`dataOf` (see the early return there), so it
// has no trajectory kind or payload. Excluding it from the map type keeps that
// invariant honest rather than mapping it to a kind that is never written.
type RecordedEventType = Exclude<
  AgentEvent["type"],
  // ADR-0512 `skill_scope_decision` is a transient render-only summary (like the
  // item-lifecycle events) — the out-of-scope outcome is already captured by the
  // tool_result trajectory line (and the DURABLE `permission_escalation_*` pair
  // IS recorded), so this summary carries no separate payload.
  | "output_progress"
  | "ratelimit_snapshot"
  | "item_started"
  | "item_updated"
  | "item_completed"
  | "skill_scope_decision"
  // jun-11 (#11) — streamed reasoning (DIM render-only); the answer is recorded
  // via `assistant_text`, so the reasoning summary carries no separate payload.
  | "assistant_thinking"
  // ALBB-21 — `budget_breach` is a transient advisory (soft/hard cost-cap
  // crossing banner); the cost totals ARE recorded via `usage`/`llm_usage`, so
  // this notice carries no separate durable payload (skipped in `emit` above).
  | "budget_breach"
>
type RecordedEvent = Extract<AgentEvent, { type: RecordedEventType }>

const KIND_MAP: Record<RecordedEventType, TrajectoryKind> = {
  session_start: "session_start",
  turn_start: "turn_start",
  llm_request: "llm_request",
  llm_continuation: "recovery",
  assistant_text: "assistant_text",
  tool_call: "tool_call",
  tool_progress: "tool_progress",
  tool_result: "tool_result",
  recovery: "recovery",
  // ADR-0075: the dedicated `context_compacted` AgentEvent maps onto the
  // existing trajectory `recovery` kind (same family — a same-turn no-progress
  // recovery point) so we DON'T need a new TrajectoryKind (which would
  // ripple through the redaction policy + every probe consumer). The
  // archive-payload fields (fromTurnId/toTurnId/summary/ts/tokens) ride in
  // `data` via `dataOf` and stay 1st-class JSON. The legacy
  // `recovery:{reason:"compact",detail:"proactive"}` line is emitted FIRST
  // at the same loop seam, so a consumer that only watches the legacy
  // channel still sees compactions byte-identically.
  context_compacted: "recovery",
  // ADR-0048: the transient `in_progress` heartbeat maps onto the existing
  // trajectory `recovery` kind (same rationale as `context_compacted` — a
  // same-turn observation point that does NOT warrant a new TrajectoryKind
  // rippling through the redaction policy + every probe consumer). The
  // heartbeat payload (timestamp + optional message/progress) rides in `data`
  // via `dataOf`, tagged `reason:"in_progress"` so it stays greppable.
  in_progress: "recovery",
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure +
  // typed-interrupt + subagent-cancel ride the existing `recovery` family
  // — they are same-turn observation points, not new top-level trajectory
  // kinds. Greppable via `reason` discriminant in `data`.
  response_queued: "recovery",
  interrupted: "recovery",
  subagent_cancel: "recovery",
  // Plan-mode cluster (P3, 2026-05-23): plan-lifecycle + user-input
  // checkpoint + mode-transition events all ride the existing `recovery`
  // family — same rationale as `response_queued` / `interrupted` /
  // `subagent_cancel` (same-turn observation point, no new TrajectoryKind
  // rippling through redaction/probe code paths). Greppable via the
  // discriminating `reason` field added in `dataOf`.
  plan_created: "recovery",
  plan_updated: "recovery",
  plan_snapshot: "recovery",
  plan_user_input_requested: "recovery",
  plan_user_input_resolved: "recovery",
  // ADR-0512 P3 — the interactive escalation pair rides the `recovery` family
  // for the SAME reason as the plan/control-op events (a same-turn observation
  // checkpoint, no new TrajectoryKind). Unlike the transient
  // `skill_scope_decision` render-hint (SKIPPED), this pair is DURABLE audit
  // state — a Codex-style auditable permission request + its resolution — so it
  // IS recorded. Greppable via the `reason` discriminant in `dataOf`.
  permission_escalation_requested: "recovery",
  permission_escalation_resolved: "recovery",
  mode_changed: "recovery",
  // ADR-0102 turn-diff cluster: rides the existing `recovery` family for
  // the same reason as the plan/control-op events (same-turn observation
  // point, no new TrajectoryKind rippling through redaction). The diff
  // payload + per-file stats ride in `data` via `dataOf`.
  turn_diff_updated: "recovery",
  // Debug/developer-mode (Track A, 2026-05-25): gate-decision tracer. Same
  // rationale as plan/control-op/turn_diff — same-turn observation point,
  // no new TrajectoryKind. `reason:"decision"` in `data` keeps it greppable.
  decision: "recovery",
  // Knob telemetry (2026-05-26): per-run resolved knob posture. Rides the
  // existing `recovery` family for the same rationale as `decision` /
  // `plan_*` / `turn_diff_updated` — a same-turn observation point, no new
  // TrajectoryKind rippling through redaction / probe / consumer code paths.
  // `reason:"knobs_applied"` keeps the line greppable apart from other
  // recovery-kind events.
  knobs_applied: "recovery",
  // C2 (jun-4-communicate-update.md): structured progress report. Rides the
  // existing `recovery` family for the same rationale as `decision` / `plan_*`
  // / `turn_diff_updated` — a same-turn observation point, no new TrajectoryKind
  // rippling through redaction / probe / consumer code paths. Unlike
  // `output_progress` (a transient token tick the recorder SKIPS), this event
  // IS recorded: it is durable agent intent. `reason:"progress_update"` keeps
  // the line greppable apart from other recovery-kind events.
  progress_update: "recovery",
  error: "error",
  usage: "llm_usage",
  done: "session_end",
}

/** AgentEvent.type → TrajectoryEvent.kind (RFC §5.2 mapping). */
const kindOf = (e: RecordedEvent): TrajectoryKind => KIND_MAP[e.type]

/** Project an AgentEvent onto its kind-specific `data` payload. */
const dataOf = (e: RecordedEvent): Record<string, unknown> => {
  switch (e.type) {
    case "session_start":
      // RFC-0002 §5.2 head marker — minimal payload (no fields mandated).
      return {}
    case "turn_start":
      return { turn: e.turn }
    case "llm_request":
      // RFC-0002 §5.2 llm_request contract: model id required, route metadata
      // optional. The model still flows through the same redaction path as
      // every other payload field.
      return {
        model: e.model,
        ...(e.provider !== undefined ? { provider: e.provider } : {}),
        ...(e.surfaceId !== undefined ? { surfaceId: e.surfaceId } : {}),
        ...(e.transportId !== undefined ? { transportId: e.transportId } : {}),
        ...(e.authMode !== undefined ? { authMode: e.authMode } : {}),
        ...(e.policy !== undefined ? { policy: e.policy } : {}),
      }
    case "llm_continuation":
      return llmContinuationData(e)
    case "assistant_text":
      return { delta: e.delta }
    case "tool_call":
      return { id: e.id, name: e.name, input: e.input }
    case "tool_progress":
      return { id: e.id, name: e.name, message: e.message }
    case "tool_result":
      // RFC-0002 §5.2 ToolResultData: keep name/ok/stdoutTail, add the
      // optional evidence only when the AgentEvent carried it (conditional-set
      // so redaction still flows through the single makeEvent source).
      return {
        name: e.name,
        ok: e.ok,
        stdoutTail: e.preview,
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(e.stderrTail !== undefined ? { stderrTail: e.stderrTail } : {}),
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.executedCommand !== undefined ? { executedCommand: e.executedCommand } : {}),
        ...(e.fullLogPath !== undefined ? { fullLogPath: e.fullLogPath } : {}),
      }
    case "recovery":
      // RFC-0002 §5.2 recovery contract: reason required, detail optional.
      return { reason: e.reason, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
    case "context_compacted":
      // ADR-0075: archive entry payload — fromTurnId..toTurnId + summary +
      // ts + tokens. `reason:"context_compacted"` is added so this
      // recovery-kind line is greppable apart from the legacy
      // `reason:"compact"` line that fires immediately before it.
      return {
        reason: "context_compacted",
        fromTurnId: e.fromTurnId,
        toTurnId: e.toTurnId,
        summary: e.summary,
        ts: e.ts,
        tokens: e.tokens,
      }
    case "in_progress":
      // ADR-0048: heartbeat payload. The two optional-field branches live in
      // `inProgressData` so this case stays a single statement (keeps `dataOf`
      // under the cognitive-complexity budget).
      return inProgressData(e)
    case "error":
      return { message: e.message }
    case "usage":
      return {
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
        costUsd: null,
      }
    case "response_queued":
      return controlOpQueuedData(e)
    case "interrupted":
      return controlOpInterruptedData(e)
    case "subagent_cancel":
      return controlOpSubagentData(e)
    case "plan_created":
      return planCreatedData(e)
    case "plan_updated":
      return planUpdatedData(e)
    case "plan_snapshot":
      return planSnapshotData(e)
    case "plan_user_input_requested":
      return planUserInputRequestedData(e)
    case "plan_user_input_resolved":
      return planUserInputResolvedData(e)
    case "permission_escalation_requested":
      // ADR-0512 P3 — auditable permission request. Optional `justification`
      // is conditionally spread so the recorded JSON is byte-exact (no
      // `undefined` field). `reason:"escalation_requested"` keeps the line
      // greppable apart from other recovery-kind events.
      return {
        reason: "escalation_requested",
        id: e.id,
        tool: e.tool,
        risk: e.risk,
        activeSkill: e.activeSkill,
        scopeReason: e.reason,
        options: [...e.options],
        ...(e.justification !== undefined ? { justification: e.justification } : {}),
      }
    case "permission_escalation_resolved":
      return { reason: "escalation_resolved", id: e.id, decision: e.decision }
    case "mode_changed":
      return modeChangedData(e)
    case "turn_diff_updated":
      // ADR-0102 turn-diff payload: stats + diff body. `reason:"turn_diff"`
      // keeps the recovery-kind line greppable apart from real recovery
      // points (mirrors `in_progress` / `response_queued` etc.).
      return {
        reason: "turn_diff",
        turn: e.turn,
        fromSha: e.fromSha,
        toSha: e.toSha,
        filesChanged: e.filesChanged,
        insertions: e.insertions,
        deletions: e.deletions,
        unifiedDiff: e.unifiedDiff,
      }
    case "decision":
      return decisionData(e)
    case "knobs_applied":
      return knobsAppliedData(e)
    case "progress_update":
      // C2 (jun-4-communicate-update.md): structured-progress payload. Optional
      // terminal fields are CONDITIONALLY spread so the recorded JSON is
      // byte-exact (no `undefined` fields). `reason:"progress_update"` keeps the
      // recovery-kind line greppable. Recorded (durable agent intent), unlike
      // the transient `output_progress` token tick the recorder skips.
      return {
        reason: "progress_update",
        currentStep: e.currentStep,
        ...(e.finalSummary !== undefined ? { finalSummary: e.finalSummary } : {}),
        ...(e.completedSubtitle !== undefined ? { completedSubtitle: e.completedSubtitle } : {}),
        ...(e.turn !== undefined ? { turn: e.turn } : {}),
      }
    case "done":
      return { reason: e.reason, turns: e.turns }
    default:
      // Exhaustiveness pin: a new AgentEvent variant must come back here and
      // declare its trajectory `data` payload — without this the return type
      // would silently widen to include `undefined` (a dropped payload).
      return assertNever(e, "AgentEvent")
  }
}

/** Debug/developer-mode (Track A, 2026-05-25): gate-decision payload.
 *  Mirrors `EventDecisionSchema` in `@/session/envelope` on the trajectory
 *  side. Optional fields are CONDITIONALLY spread so the recorded JSON is
 *  byte-identical to inputs (no `undefined` fields). `reason:"decision"`
 *  keeps this recovery-kind line greppable. Extracted from `dataOf` to keep
 *  its switch case a single statement (cognitive-complexity budget). */
const decisionData = (e: Extract<AgentEvent, { type: "decision" }>): Record<string, unknown> => ({
  reason: "decision",
  turn: e.turn,
  kind: e.kind,
  outcome: e.outcome,
  decisionReason: e.reason,
  ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
  ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
  ...(e.hookName !== undefined ? { hookName: e.hookName } : {}),
  ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
})

/** Responses continuation-wire observation payload. Rides the existing
 *  `recovery` family because this is same-turn transport metadata, not a new
 *  top-level trajectory kind. `reason:"llm_continuation"` keeps the line
 *  greppable while `continuationReason` carries the closed decision/fallback
 *  taxonomy from the LLM surface. */
const llmContinuationData = (
  e: Extract<AgentEvent, { type: "llm_continuation" }>,
): Record<string, unknown> => ({
  reason: "llm_continuation",
  ...(e.provider !== undefined ? { provider: e.provider } : {}),
  surfaceId: e.surfaceId,
  transportId: e.transportId,
  phase: e.phase,
  mode: e.mode,
  continuationReason: e.reason,
  ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
})

/** Knob telemetry (2026-05-26): per-run resolved knob posture payload. The
 *  carrier event is emitted once per run; the recorder writes it as one
 *  JSONL line with `kind:"recovery"` (no new TrajectoryKind needed) and
 *  `reason:"knobs_applied"` for grep. `preset` is intentionally serialised
 *  even when `null` (the type uses `string | null`, NOT optional) so a
 *  consumer can distinguish "knob system live but no preset" from "absent
 *  field". `knobs` is a plain object — same shape the bench report uses
 *  (`knobsForReport(...)`), so two artifacts (jsonl trajectory line +
 *  report.json `knobs` block) can be cross-correlated trivially. */
const knobsAppliedData = (
  e: Extract<AgentEvent, { type: "knobs_applied" }>,
): Record<string, unknown> => ({
  reason: "knobs_applied",
  surface: e.surface,
  knobs: e.knobs,
  preset: e.preset,
  costMultiplier: e.costMultiplier,
})

/** ADR-0048: heartbeat payload — receive-side timestamp + the optional
 *  provider-supplied status/percentage. `reason:"in_progress"` keeps this
 *  recovery-kind line greppable apart from real recovery points. Extracted from
 *  `dataOf` so its switch case stays a single statement. */
const inProgressData = (
  e: Extract<AgentEvent, { type: "in_progress" }>,
): Record<string, unknown> => ({
  reason: "in_progress",
  timestamp: e.timestamp,
  ...(e.message !== undefined ? { message: e.message } : {}),
  ...(e.progress !== undefined ? { progress: e.progress } : {}),
})

/** ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure event
 *  payload. `reason` discriminator matches the canonical PausedReason
 *  taxonomy (extended with `control_op_pending`/`safety_review` per
 *  `@/agent/control-op-handler`). Extracted from `dataOf` to keep its switch
 *  case a single statement (cognitive-complexity budget). */
const controlOpQueuedData = (
  e: Extract<AgentEvent, { type: "response_queued" }>,
): Record<string, unknown> => ({
  reason: "response_queued",
  pauseReason: e.reason,
  ...(e.hint !== undefined ? { hint: e.hint } : {}),
})

/** ADR control-op cluster: typed-interrupt observation payload. `reason`
 *  field doubles as discriminator + verbatim cancel reason carrier. */
const controlOpInterruptedData = (
  e: Extract<AgentEvent, { type: "interrupted" }>,
): Record<string, unknown> => ({
  reason: "interrupted",
  source: e.source,
  ...(e.reason !== undefined ? { detail: e.reason } : {}),
})

/** ADR control-op cluster: subagent cancel routing result. Parent turn
 *  KEEPS running — this is observation only, not a finish trigger. */
const controlOpSubagentData = (
  e: Extract<AgentEvent, { type: "subagent_cancel" }>,
): Record<string, unknown> => ({
  reason: "subagent_cancel",
  subagentId: e.subagentId,
  outcome: e.outcome,
  source: e.source,
})

/** Plan-mode cluster (P3): plan_created payload. Inline the plan as a plain
 *  JSON object so consumers can rebuild a `PlanReadonlyMirror` without
 *  re-importing the type. `reason:"plan_created"` matches the recovery-family
 *  discriminator pattern used by response_queued/interrupted/subagent_cancel. */
const planCreatedData = (
  e: Extract<AgentEvent, { type: "plan_created" }>,
): Record<string, unknown> => ({
  reason: "plan_created",
  plan: planToJson(e.plan),
})

/** Plan-mode cluster (P3): plan_updated payload. `version` is the monotonic
 *  plan version after the delta has been applied (so a consumer can detect
 *  out-of-order deliveries by comparing against the previous `plan_updated` /
 *  `plan_snapshot`). */
const planUpdatedData = (
  e: Extract<AgentEvent, { type: "plan_updated" }>,
): Record<string, unknown> => ({
  reason: "plan_updated",
  version: e.version,
  delta: deltaToJson(e.delta),
})

/** Plan-mode cluster (P3): plan_snapshot payload (late-attach surface). Same
 *  shape as plan_created; the `reason` discriminator is what tells the two
 *  apart. */
const planSnapshotData = (
  e: Extract<AgentEvent, { type: "plan_snapshot" }>,
): Record<string, unknown> => ({
  reason: "plan_snapshot",
  plan: planToJson(e.plan),
})

/** Plan-mode cluster (P3): user-input request. Emit `choices` only when
 *  provided (exactOptionalPropertyTypes-safe). */
const planUserInputRequestedData = (
  e: Extract<AgentEvent, { type: "plan_user_input_requested" }>,
): Record<string, unknown> => ({
  reason: "plan_user_input_requested",
  promptId: e.promptId,
  prompt: e.prompt,
  ...(e.choices !== undefined ? { choices: [...e.choices] } : {}),
})

/** Plan-mode cluster (P3): user-input resolved. `text` is emitted only when
 *  present (a `"cancelled"` decision carries no text). */
const planUserInputResolvedData = (
  e: Extract<AgentEvent, { type: "plan_user_input_resolved" }>,
): Record<string, unknown> => ({
  reason: "plan_user_input_resolved",
  promptId: e.promptId,
  decision: e.decision,
  ...(e.text !== undefined ? { text: e.text } : {}),
})

/** Plan-mode cluster (P3): collaboration-mode transition. `reason` is emitted
 *  only when present. The finer `fromAgentMode` / `toAgentMode` posture fields
 *  ride through unchanged when the emitter supplied them. */
const modeChangedData = (
  e: Extract<AgentEvent, { type: "mode_changed" }>,
): Record<string, unknown> => ({
  reason: "mode_changed",
  from: e.from,
  to: e.to,
  ...(e.fromAgentMode !== undefined ? { fromAgentMode: e.fromAgentMode } : {}),
  ...(e.toAgentMode !== undefined ? { toAgentMode: e.toAgentMode } : {}),
  ...(e.reason !== undefined ? { transitionReason: e.reason } : {}),
})

/** Project a PlanReadonlyMirror to a plain JSON object. Pure — no clock, no
 *  IO. Used by `plan_created` and `plan_snapshot` payloads. */
const planToJson = (
  plan: Extract<AgentEvent, { type: "plan_created" }>["plan"],
): Record<string, unknown> => ({
  id: plan.id,
  name: plan.name,
  version: plan.version,
  todos: plan.todos.map((t) => ({ id: t.id, title: t.title, status: t.status })),
})

/** Project a PlanDeltaReadonlyMirror to a plain JSON object. Conditional-set
 *  on every optional field so absent fields don't leak as `undefined` into
 *  the JSON line. */
const deltaToJson = (
  delta: Extract<AgentEvent, { type: "plan_updated" }>["delta"],
): Record<string, unknown> => ({
  kind: delta.kind,
  ...(delta.todoId !== undefined ? { todoId: delta.todoId } : {}),
  ...(delta.todoTitle !== undefined ? { todoTitle: delta.todoTitle } : {}),
  ...(delta.fromStatus !== undefined ? { fromStatus: delta.fromStatus } : {}),
  ...(delta.toStatus !== undefined ? { toStatus: delta.toStatus } : {}),
  ...(delta.fromName !== undefined ? { fromName: delta.fromName } : {}),
  ...(delta.toName !== undefined ? { toName: delta.toName } : {}),
})

/** Deterministic span/parent for an event given the active turn span. */
const spanOf = (e: AgentEvent, turnSpanId: string): { spanId?: string; parentSpanId?: string } => {
  switch (e.type) {
    case "turn_start":
      return { spanId: turnSpanId }
    case "tool_call":
    case "tool_progress":
    case "tool_result":
      return { spanId: `tool:${e.id}`, parentSpanId: turnSpanId }
    // RFC-0002 §5.2/§9/§11 span pair: `llm_request` (pre-stream) and `usage`
    // (post-stream `llm_usage`) of the SAME turn share ONE llm span, so
    // request.spanId === usage.spanId === `llm:${turnSpanId}`, parented at the
    // turn span. One request → one usage per turn keeps the pair unambiguous.
    case "llm_request":
    case "llm_continuation":
    case "usage":
      return { spanId: `llm:${turnSpanId}`, parentSpanId: turnSpanId }
    default:
      return { parentSpanId: turnSpanId }
  }
}
