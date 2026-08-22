import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Producer, RunContext, TrajectoryKind } from "@/shared"
import { errMessage, logger, makeEvent, toError } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"
import { dataOf } from "./jsonl-recorder-data"
import { kindOf } from "./jsonl-recorder-kind-map"
import type { DegradedRecord } from "./tee"

/** Transient, NON-accounting advisory event types the recorder DROPS (the
 *  cost/token totals are recorded via the `usage`/`llm_usage` line). Every
 *  entry is also excluded from `RecordedEventType` (jsonl-recorder-kind-map)
 *  so KIND_MAP / dataOf
 *  never see them. A typed predicate (below) narrows `event` by EXCLUDING these
 *  from the `RecordedEvent` union while collapsing the skip into ONE branch —
 *  so `emit`'s cognitive complexity does not grow as advisories are added. */
type NonAccountingAdvisoryType = "budget_breach" | "context_headroom_crossed"
const isNonAccountingAdvisory = (
  event: AgentEvent,
): event is Extract<AgentEvent, { type: NonAccountingAdvisoryType }> =>
  event.type === "budget_breach" || event.type === "context_headroom_crossed"

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
  /**
   * ADR-0539 rule 5 enforcement (jul-13, "no per-event legacy fallback in
   * unified mode"). DI seam that answers "was a live trace context EXPECTED for
   * this emit?" — the composition root binds it to `() => getSpanSink() !== null`
   * (a live span sink means `withActiveSpanScope` wraps every recorded unit, so
   * EVERY event should see a `getActiveTraceRef()` ref). When this returns
   * `true` AND `getActiveTraceRef()` yields `undefined`, that is a genuine
   * correlation DEFECT (context expected-but-missing) — the recorder emits ONE
   * `observability_degraded` line (`reason:"missing_trace_context"`) and, in
   * `strict` mode, surfaces it on the rail; it does NOT silently synthesize the
   * deterministic `t<turn>` id and move on.
   *
   * When ABSENT or returning `false`, no context is expected (OTel off /
   * context-never-wired — the LEGITIMATE case): the deterministic `t<turn>`
   * fallback stays and output is BYTE-IDENTICAL to today. Deliberately a plain
   * inline callback (mirroring `getActiveTraceRef`) so `@/stream` never imports
   * `@/observability` (slice boundary, guarded by stream-slice-boundary.test.ts).
   */
  traceContextExpected?: () => boolean
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
      } catch (e) {
        // Best-effort: a torn-down volume must not abort the teardown path or
        // block the remaining recorders. The tail we could save, we saved.
        logger.warn("jsonl-recorder: signal flush failed", { error: errMessage(e) })
      }
    }
  }
  // Do not consume the signal (no re-emit / process.exit): we only piggy-back a
  // flush; the runtime's default disposition (and any user handler) still runs.
  try {
    process.on("SIGTERM", flushAll)
    process.on("SIGINT", flushAll)
  } catch (e) {
    // Some sandboxes forbid signal registration — degrade to turn-boundary
    // flush only rather than crash the recorder at construction time.
    logger.warn("jsonl-recorder: signal handler registration failed", { error: errMessage(e) })
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
  private readonly traceContextExpected: (() => boolean) | undefined
  private readonly maxLines: number
  private readonly producer: Producer | undefined
  private readonly buf: string[] = []
  private readonly pending: PendingChunk[] = []
  private seq = 0
  private written = 0
  private turnSpanId = "t#init"
  private closed = false
  private capDone = false
  /** ADR-0539 rule 5: latched once the expected-but-missing trace-context
   *  defect has been reported, so a SYSTEMIC missing context (affecting every
   *  event) emits exactly ONE degraded line — mirrors `capDone`. */
  private missingRefReported = false
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
    this.traceContextExpected = opts.traceContextExpected
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
    // `RecordedEventType` (jsonl-recorder-kind-map) so `KIND_MAP` / `dataOf` never see it).
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
    // `RecordedEventType` (jsonl-recorder-kind-map) so KIND_MAP / dataOf never see it.
    if (event.type === "assistant_thinking") return
    // ALBB-21 `budget_breach` + RFC-01 A7 `context_headroom_crossed` are
    // transient, NON-accounting advisories (cost-cap / context-headroom
    // banners), the SAME class as `ratelimit_snapshot` / `output_progress`: the
    // cost/token totals ARE recorded via the `usage`/`llm_usage` line, so the
    // recorder SKIPS them — both kept out of `RecordedEventType` (jsonl-recorder-kind-map) so
    // KIND_MAP / dataOf never see them. ONE typed-predicate branch (narrows the
    // remaining `event` to the recorded union) so this method's complexity is
    // flat as advisories are added.
    if (isNonAccountingAdvisory(event)) return
    // Multi-agent-panel SUBSTRATE — subagent lifecycle events are transient,
    // render-only UI signals (the SAME class as `item_*` / `budget_breach`): the
    // durable subagent trajectory rides the ADR-0133 hooks + the parent `agent`
    // tool_result, so the recorder SKIPS them (kept out of `RecordedEventType`
    // so KIND_MAP / dataOf never see them).
    if (event.type === "subagent_spawn" || event.type === "subagent_status") return
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
    // stays byte-identical to today.
    const ref = this.getActiveTraceRef?.()
    // ADR-0539 rule 5 (jul-13 — NOW ENFORCED): a missing ref while a trace
    // context was EXPECTED (span sink live ⇒ every emit is wrapped in
    // `withActiveSpanScope`) is a correlation DEFECT, not the legitimate
    // off/unwired case. Report it exactly once (systemic ⇒ don't spam) and let
    // strict surface it on the rail. The deterministic `t<turn>` fallback below
    // still runs so the line is not lost — the DEFECT is the ADDED signal, and
    // the off/never-expected path stays byte-identical (guard returns early).
    // `kind !== "observability_degraded"` prevents self-recursion: the degraded
    // line this reports is itself framed here.
    if (ref === undefined && kind !== "observability_degraded") this.checkMissingTraceContext(kind)
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
    } catch (e) {
      // best-effort: the cap line itself is allowed to fail silently
      logger.warn("jsonl-recorder: line-cap degraded record write failed", { error: errMessage(e) })
    }
  }

  /**
   * ADR-0539 rule 5 enforcement. Called from `frame()` when the active trace
   * ref is `undefined`. If a trace context was EXPECTED (span sink live), the
   * missing ref is a correlation DEFECT: emit ONE `observability_degraded` line
   * (`reason:"missing_trace_context"`, latched via `missingRefReported`) and, in
   * strict mode, THROW so the failure surfaces on the rail (routed through the
   * SAME `record()`→`degrade()` catch as any other strict rail failure). When no
   * context was expected (callback absent / returns false), this is a no-op ⇒
   * the off/unwired path stays byte-identical.
   */
  private checkMissingTraceContext(offendingKind: TrajectoryKind): void {
    if (this.traceContextExpected?.() !== true) return
    if (!this.missingRefReported) {
      this.missingRefReported = true
      // Direct-append the degraded line (bypasses the buffered path so the
      // signal lands even if the buffer is wedged) — the offending kind + seq
      // give an operator the first defective event for triage.
      this.tryDegradedLine("missing_trace_context", {
        offendingKind,
        offendingSeq: this.seq,
      })
    }
    // Strict: surface every defect on the rail (not just the first) — the
    // record()/frame() caller's catch turns this into the strict rethrow, the
    // same contract a write/serialize failure takes.
    if (this.strict) {
      throw new Error(
        `observability degraded: missing_trace_context (kind=${offendingKind}, seq=${this.seq})`,
      )
    }
  }

  private degrade(err: Error, rethrow: boolean): void {
    this.dropped += 1
    if (rethrow) throw err
    this.tryDegradedLine(err.message)
  }

  private tryDegradedLine(reason: string, extra?: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(
        this.frame(
          "observability_degraded",
          { component: "JsonlRecorder", reason, droppedEvents: this.dropped, ...extra },
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
