/**
 * Web-daemon control-request frame decoder (ADR-0496 A1 — the inbound producer).
 *
 * A browser/IDE client steers the LIVE session's runtime controls (set_model /
 * set_permission_mode / set_thinking / get_context_usage) by sending a
 * `controlRequest` WS frame. Like {@link ./server/ws-handlers#peekPlanInputAnswer}
 * and {@link ./follower-verb-frame#peekFollowerVerb}, this is peeked + CONSUMED at
 * the connection layer BEFORE the session bridge — it is NOT a `SessionCommand`
 * and never reaches the kernel reducer. The server enqueues the decoded request
 * onto the {@link ./web-control-request-port} whose port the turn loop drains.
 *
 * Frame shape: `{ "kind": "controlRequest", "request": <ControlRequest> }`. The
 * decoder does ONLY the OUTER envelope + the discriminant + the per-kind payload
 * shape (so a garbage `request` never reaches the port). The pure
 * `planControlRequest` remains the single source of CONTENT validation
 * (allowlist checks, fail-closed) — this never duplicates the allowlists. Returns
 * `null` for any non-controlRequest / malformed frame ⇒ it falls through to the
 * session bridge exactly as before (byte-identical when the gate is off, since
 * the server only calls this under the gate).
 */

import type { ControlRequest } from "@/agent/control-request"

/**
 * Decode a raw WS frame into a candidate {@link ControlRequest}, or `null` when
 * the frame is not a well-formed `controlRequest` envelope. Validates the outer
 * envelope + the discriminant `kind` + the payload field REQUIRED by that kind
 * (a `string` model/mode/level). Off-allowlist / semantic validation is left to
 * `planControlRequest` — this only confirms the SHAPE is drainable.
 *
 * NO-THROW: a non-JSON / non-matching frame returns `null` rather than throwing.
 */
export const peekControlRequest = (raw: string): ControlRequest | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "controlRequest") return null
  const request = obj.request
  if (request === null || typeof request !== "object" || Array.isArray(request)) return null
  const req = request as Record<string, unknown>
  switch (req.kind) {
    case "set_model":
      return typeof req.model === "string" ? { kind: "set_model", model: req.model } : null
    case "set_permission_mode":
      return typeof req.mode === "string" ? { kind: "set_permission_mode", mode: req.mode } : null
    case "set_thinking":
      return typeof req.level === "string" ? { kind: "set_thinking", level: req.level } : null
    case "get_context_usage":
      return { kind: "get_context_usage" }
    default:
      // Unknown / garbage discriminant ⇒ not a drainable control request. The
      // frame falls through to the session bridge (byte-identical).
      return null
  }
}
