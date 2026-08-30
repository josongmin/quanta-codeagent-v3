/**
 * Web-daemon `goalWork` frame decoder (GOAL-08 rail 15, web half).
 *
 * A browser/IDE client asks the LIVE session for ONE user-requested goal turn
 * by sending `{ "kind": "goalWork", "text": "<instruction>" }` — the web
 * equivalent of the CLI's `/goal work`. Like {@link ./control-request-frame}
 * and {@link ./follower-verb-frame} this is peeked + CONSUMED at the connection
 * layer BEFORE the session bridge: it is NOT a `SessionCommand` and never
 * reaches the kernel reducer (no wire-protocol drift; the host verb
 * `turn.submitGoalWork` is the ONLY thing that can mint the
 * `user-requested-goal-work` capability, so a raw client still cannot forge
 * provenance).
 *
 * The decoder validates ONLY the envelope + a non-blank string `text`. Content
 * bounds (length) and goal state (active / attempt slot healthy) are the
 * composed handler's contract — never duplicated here. NO-THROW: a non-JSON /
 * non-matching frame returns `null` ⇒ it falls through to the session bridge
 * exactly as before.
 */

/** The decoded request. An object (not a bare string) so the frame can grow
 *  fields without changing the consumer's shape. */
export interface GoalWorkRequest {
  readonly text: string
  /** Optional client correlation id, echoed on every `goalWorkResult` for this
   *  request. With two requests outstanding the acks are otherwise
   *  indistinguishable. Absent ⇒ the result frame carries no id. */
  readonly requestId?: string
}

/** Is this frame OURS at all? Independent of whether the request inside it is
 *  usable. The distinction is load-bearing: a frame we do not own must fall
 *  through to the session bridge untouched, while a frame we DO own must be
 *  answered even when its payload is unusable — otherwise the client, which has
 *  no timeout, waits forever for an ack that is never coming. Returns the
 *  correlation id (when the client sent one) so the refusal can carry it. */
export const peekGoalWorkEnvelope = (raw: string): { readonly requestId?: string } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "goalWork") return null
  const requestId = obj.requestId
  return typeof requestId === "string" && requestId.length > 0 ? { requestId } : {}
}

export const peekGoalWork = (raw: string): GoalWorkRequest | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "goalWork") return null
  const text = obj.text
  if (typeof text !== "string") return null
  // CLI parity: `/goal work <instruction>` trims. A blank request is not a
  // request (the handler would only refuse it after a pointless dispatch).
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const requestId = obj.requestId
  return typeof requestId === "string" && requestId.length > 0
    ? { text: trimmed, requestId }
    : { text: trimmed }
}
