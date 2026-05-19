import { redactValue } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"

/** Minimal write target. A real HTTP handler passes a response writer; tests
 *  pass an in-memory buffer. Keeps this adapter transport-agnostic. */
export interface SseSink {
  write: (chunk: string) => void
}

export interface SseOptions {
  /** Injectable clock for deterministic ids/timestamps in tests. */
  now?: () => number
}

/**
 * Serializes every {@link AgentEvent} as a spec-correct Server-Sent Events
 * frame: an `event:` line (the discriminant), one or more `data:` lines, and
 * a per-frame monotonic `id:` line, terminated by a blank line.
 *
 * Multiline handling: `JSON.stringify` never emits a raw newline (newlines in
 * strings are escaped as `\\n`), so a single `data:` line is always correct.
 * We still defensively split the payload on `\n` into one `data:` line each,
 * per the SSE spec (a literal LF in a `data:` field would otherwise be parsed
 * as a frame-internal record boundary). This makes the splitter robust if a
 * future serializer ever produces embedded newlines.
 *
 * close() semantics: flips an internal `closed` flag. Subsequent emit() calls
 * are a silent no-op (chosen over throwing so a late event from the agent can
 * never crash an already-finished response). comment() is likewise a no-op
 * once closed.
 */
export class SseStream implements StreamPort {
  private readonly sink: SseSink
  private readonly now: () => number
  private nextId = 0
  private closed = false

  constructor(sink: SseSink, options: SseOptions = {}) {
    this.sink = sink
    this.now = options.now ?? Date.now
  }

  emit(event: AgentEvent): void {
    if (this.closed) return
    const id = this.nextId
    this.nextId += 1
    // S4: route the event through the single-source @/shared scrub BEFORE
    // serialize so secret values (tool_call.input, tool_result.preview/
    // stderrTail, assistant_text.delta, error.message, …) never reach the
    // wire. redactValue preserves shape — only string/keyed values are masked.
    const json = JSON.stringify(redactValue(event))
    const frame = `id: ${id}\nevent: ${event.type}\n${dataLines(json)}\n`
    this.sink.write(frame)
  }

  /** SSE keep-alive comment line (`: <text>`). No-op once closed. */
  comment(text: string): void {
    if (this.closed) return
    this.sink.write(`${dataLines(text, ": ")}\n`)
  }

  /** Returns the injected clock value (deterministic in tests). */
  timestamp(): number {
    return this.now()
  }

  /** Idempotently marks the stream closed; further emit/comment are no-ops. */
  close(): void {
    this.closed = true
  }
}

/**
 * Renders `payload` as SSE field lines, one physical line per `\n`-delimited
 * segment, each prefixed with `prefix` (default `"data: "`). The result ends
 * with a single trailing `\n`; the caller appends the blank line that
 * terminates the frame.
 */
const dataLines = (payload: string, prefix = "data: "): string =>
  payload
    .split("\n")
    .map((line) => `${prefix}${line}\n`)
    .join("")
