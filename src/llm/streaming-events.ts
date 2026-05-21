/**
 * Streaming-event decoders for OpenAI Responses API (ADR-0048).
 *
 * Codex's WebSocket dispatcher (build 2867 round-4 audit) silently drops the
 * `response.in_progress` event because its `event.kind` switch has no branch
 * for it. The frame is harmless to drop — the model is "still generating" with
 * nothing new to show — but a UI that wants to render a "thinking..." cue
 * cannot do so without polling. We surface the event as a first-class
 * {@link StreamEvent} from day one so the consumer (CLI renderer, Web/Tauri,
 * any future surface) gets it for free.
 *
 * Forward-compat contract:
 *   - `response.in_progress` is now KNOWN — emitted as
 *     `{ type: "response_in_progress", data: ... }`.
 *   - Any OTHER `response.*` (or unrecognized) event passes through silently,
 *     with one debug-level log line so a future provider rollout that adds a
 *     new event is discoverable without breaking the parser.
 *   - The `data` field is `Record<string, unknown>` on purpose: provider schema
 *     drifts (progress/message/elapsed are the usual fields, but rolls happen),
 *     so the consumer narrows fields it actually needs.
 *
 * This module is intentionally pure and side-effect-free aside from the debug
 * log; the adapter wraps it. Tests drive the decoders directly.
 */

import { log } from "@/observability"
import type { StreamEvent } from "./types"

// ---------------------------------------------------------------------------
// SSE frame parser (OpenAI Responses API HTTP/streaming format)
// ---------------------------------------------------------------------------

/** One parsed SSE frame: an `event:` line plus the joined `data:` lines.
 *  Both fields are required — incomplete frames are filtered out upstream. */
export interface SseFrame {
  event: string
  data: string
}

/** Parse a single SSE frame text block (lines terminated by `\n`) into the
 *  `{event, data}` view. Returns `null` if either field is missing — the
 *  frame is structurally invalid and should be skipped rather than throw.
 *
 *  SSE wire shape we accept:
 *    event: response.in_progress
 *    data: {"progress":0.42,"message":"..."}
 *
 *  Multiline `data:` is joined with `\n` between fragments (per SSE spec).
 *  Leading whitespace after `event:`/`data:` is trimmed. */
export const parseSseFrame = (text: string): SseFrame | null => {
  let event: string | null = null
  const dataLines: string[] = []
  for (const raw of text.split("\n")) {
    if (raw.startsWith("event:")) {
      event = raw.slice(6).trim()
    } else if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).replace(/^ /, ""))
    }
  }
  if (event === null || dataLines.length === 0) return null
  return { event, data: dataLines.join("\n") }
}

/** Decode one SSE frame to a {@link StreamEvent}, or `null` if the frame is
 *  not a known event type (Responses API surface adds events over time — we
 *  drop unknowns rather than throw so a provider rollout never wedges a turn).
 *
 *  Today's KNOWN events:
 *    - `response.in_progress` ⇒ `response_in_progress` StreamEvent.
 *
 *  Unknown events log once at debug level so a future event addition is
 *  visible during development without breaking production streams. */
export const decodeSseEvent = (frame: SseFrame): StreamEvent | null => {
  if (frame.event === "response.in_progress") {
    return { type: "response_in_progress", data: safeParseJson(frame.data) }
  }
  log.debug("unknown_sse_event", { event: frame.event })
  return null
}

// ---------------------------------------------------------------------------
// WebSocket envelope parser (OpenAI Responses API WS variant)
// ---------------------------------------------------------------------------

/** Minimal structural view of a WebSocket event envelope. Codex's wire shape
 *  uses `kind` (not `event`) for the discriminator. The remaining fields are
 *  opaque to the parser. */
export interface WsEventEnvelope {
  kind: string
  [key: string]: unknown
}

/** Decode one WebSocket event envelope to a {@link StreamEvent}, or `null` if
 *  the kind is not recognized. Same forward-compat contract as SSE: known kinds
 *  map to a StreamEvent; unknown kinds log at debug and return `null`. */
export const decodeWsEvent = (env: WsEventEnvelope): StreamEvent | null => {
  if (env.kind === "response.in_progress") {
    // The WS envelope carries the payload inline (data/progress/message at the
    // root). Strip the discriminator so the StreamEvent's `data` field is a
    // pure payload bag.
    const { kind: _kind, ...rest } = env
    return { type: "response_in_progress", data: rest as Record<string, unknown> }
  }
  log.debug("unknown_ws_event", { kind: env.kind })
  return null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Permissive JSON parse: returns `{}` on parse failure so a malformed payload
 *  never crashes the parser. The frame discriminator is already validated; a
 *  bad data field is a provider bug we don't want to propagate. */
const safeParseJson = (raw: string): Record<string, unknown> => {
  if (raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}
