/**
 * Web-daemon follower-verb frame decoder (T02 — web 2nd-client transport).
 *
 * A FOLLOWER (a second browser/ide client on the shared session) co-controls the
 * live thread by sending a `followerVerb` WS frame. Like `peekPlanInputAnswer`,
 * this is peeked + CONSUMED at the connection layer BEFORE the session bridge —
 * it is NOT a `SessionCommand` and never reaches the kernel reducer. The server
 * routes the decoded verb to a {@link FollowerCoControlDispatcher} whose sinks
 * are bound to the session's conversation-action surface (steer → inject into the
 * lease holder's running turn) + inbound-mode ref (set-queue-mode) + the
 * lease-bypass cancel (interrupt).
 *
 * Frame shape: `{ "kind": "followerVerb", "verb": <FollowerVerb> }`. The decoder
 * does only the OUTER shape check (kind + a verb object carrying a string
 * `kind`); the dispatcher's `planFollowerVerb` is the single source of CONTENT
 * validation (NO-THROW, rejects garbage), so this never duplicates the verb
 * vocabulary. Returns null for any non-follower / malformed frame ⇒ it falls
 * through to the session bridge exactly as before (byte-identical when the gate
 * is off, since the server only calls this under the gate).
 *
 * Verb routing (in `server.ts`): a `command-approval-decision` verb is routed to
 * the follower approval-relay TIMEOUT coordinator (deadline/stale + the resolver's
 * LIVE HARD_DENY re-check, which fires `approval.respond`); the FIRE verbs
 * (steer-turn / interrupt-turn / set-queue-mode) go to the dispatcher. This
 * decoder validates only the OUTER envelope for BOTH — `planFollowerVerb` /
 * the coordinator own content validation.
 */
import type { FollowerVerb } from "@/agent/thread-follower"

/**
 * Decode a raw WS frame into a candidate {@link FollowerVerb}, or null when the
 * frame is not a well-formed `followerVerb` envelope. Content validation is left
 * to `planFollowerVerb` — this only confirms the envelope + that `verb` is an
 * object with a string discriminant.
 */
export const peekFollowerVerb = (raw: string): FollowerVerb | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "followerVerb") return null
  const verb = obj.verb
  if (verb === null || typeof verb !== "object" || Array.isArray(verb)) return null
  if (typeof (verb as Record<string, unknown>).kind !== "string") return null
  // The outer envelope is well-formed; hand the inner verb to the dispatcher,
  // which re-validates content (and rejects an approval-decision routed here).
  return verb as FollowerVerb
}
