import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Producer, RunContext, TrajectoryKind } from "@/shared"
import { logger, makeEvent, toError } from "@/shared"
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
  /** Hard line cap; once exceeded only a final `line_cap` degraded line is
   *  written. Default 100000. */
  maxLines?: number
  producer?: Producer
}

const DEFAULT_MAX_LINES = 100_000
const FLUSH_BATCH = 16
const EMPTY_CTX: RunContext = { runId: "unknown" }

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
  private readonly maxLines: number
  private readonly producer: Producer | undefined
  private readonly buf: string[] = []
  private seq = 0
  private written = 0
  private turnSpanId = "t#init"
  private closed = false
  private capDone = false
  private dropped = 0

  constructor(
    private readonly target: string,
    opts: JsonlRecorderOpts = {},
  ) {
    this.ctx = opts.ctx ?? EMPTY_CTX
    this.strict = opts.strict ?? false
    this.now = opts.now ?? (() => Date.now())
    this.monotonic = opts.monotonic
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
    this.producer = opts.producer
    mkdirSync(dirname(target), { recursive: true })
  }

  emit(event: AgentEvent): void {
    if (event.type === "turn_start") this.turnSpanId = `t${event.turn}`
    if (this.written >= this.maxLines) {
      this.handleCap()
      return
    }
    this.record(kindOf(event), dataOf(event), spanOf(event, this.turnSpanId))
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
    return makeEvent(this.seq++, kind, this.ctx, data, {
      ts: this.now(),
      ...(this.monotonic ? { monotonicNs: this.monotonic() } : {}),
      ...(span.spanId !== undefined ? { spanId: span.spanId } : {}),
      ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
      ...(this.producer ? { producer: this.producer } : {}),
    })
  }

  private handleCap(): void {
    if (this.capDone) return
    this.capDone = true
    this.dropped += 1
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
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** Buffered append. Monkeypatch target in tests to force write failure. */
  private writeLine(line: string): void {
    this.buf.push(`${line}\n`)
    this.written += 1
  }

  private flushMaybe(): void {
    if (this.buf.length >= FLUSH_BATCH) this.flush()
  }

  flush(): void {
    if (this.buf.length === 0) return
    const chunk = this.buf.join("")
    this.buf.length = 0
    appendFileSync(this.target, chunk)
  }

  /** Flush + close. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.flush()
  }

  /** Snapshot of degraded state for the caller. */
  degraded(): DegradedRecord[] {
    if (this.dropped === 0) return []
    return [{ component: "JsonlRecorder", reason: "write_failure", count: this.dropped }]
  }
}

const KIND_MAP: Record<AgentEvent["type"], TrajectoryKind> = {
  session_start: "session_start",
  turn_start: "turn_start",
  llm_request: "llm_request",
  assistant_text: "assistant_text",
  tool_call: "tool_call",
  tool_progress: "tool_progress",
  tool_result: "tool_result",
  recovery: "recovery",
  error: "error",
  usage: "llm_usage",
  done: "session_end",
}

/** AgentEvent.type → TrajectoryEvent.kind (RFC §5.2 mapping). */
const kindOf = (e: AgentEvent): TrajectoryKind => KIND_MAP[e.type]

/** Project an AgentEvent onto its kind-specific `data` payload. */
const dataOf = (e: AgentEvent): Record<string, unknown> => {
  switch (e.type) {
    case "session_start":
      // RFC-0002 §5.2 head marker — minimal payload (no fields mandated).
      return {}
    case "turn_start":
      return { turn: e.turn }
    case "llm_request":
      // RFC-0002 §5.2 llm_request contract: just the model id (scrubbed via
      // the single makeEvent/redactValue source like every other payload).
      return { model: e.model }
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
        ...(e.fullLogPath !== undefined ? { fullLogPath: e.fullLogPath } : {}),
      }
    case "recovery":
      // RFC-0002 §5.2 recovery contract: reason required, detail optional.
      return { reason: e.reason, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
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
    case "done":
      return { reason: e.reason, turns: e.turns }
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
    case "usage":
      return { spanId: `llm:${turnSpanId}`, parentSpanId: turnSpanId }
    default:
      return { parentSpanId: turnSpanId }
  }
}
